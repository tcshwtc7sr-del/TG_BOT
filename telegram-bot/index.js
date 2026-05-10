const fs = require("fs");
const os = require("os");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in environment");

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => !Number.isNaN(x));
const WORK_START_HOUR = toHour(process.env.WORK_START_HOUR, 9);
const WORK_END_HOUR = toHour(process.env.WORK_END_HOUR, 18);
const REMINDER_MINUTES_BEFORE = toPositiveInt(process.env.REMINDER_MINUTES_BEFORE, 30);
const PENDING_TTL_HOURS = toPositiveInt(process.env.PENDING_TTL_HOURS, 24);
/** Дата/время в брони — «настенные часы» организации (без суффикса Z). Должны совпадать с BOOKING_TIMEZONE. */
const BOOKING_TIMEZONE = process.env.BOOKING_TIMEZONE || "Europe/Moscow";
const BOOKING_LOCAL_OFFSET = process.env.BOOKING_LOCAL_OFFSET || "+03:00";
/** В «Истории действий» и при очистке: записи старше N суток считаются устаревшими */
const ACTION_LOG_RETENTION_DAYS = Math.max(1, toPositiveInt(process.env.ACTION_LOG_RETENTION_DAYS, 30));
/** Интервал плановой очистки: архив CSV всем админам → удаление записей старше ACTION_LOG_RETENTION_DAYS */
const ACTION_LOG_PURGE_INTERVAL_DAYS = Math.max(1, toPositiveInt(process.env.ACTION_LOG_PURGE_INTERVAL_DAYS, 30));

// Локально: telegram-bot/data. На Amvera и др.: задайте DATA_DIR=/data (абсолютный путь к постоянному диску).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
/** Короткие имена в данных и callback; на кнопках и в текстах — см. formatRoomForDisplay / roomButtonLabel */
const ROOM_OPTIONS = ["Конференц-зал", "Общий-зал", "Актовый-зал"];
const ROOM_BUTTON_LABEL = {
  "Конференц-зал": "Конференц-зал (стекляшка) 👥25",
  "Общий-зал": "Общий-зал 👥70",
  "Актовый-зал": "Актовый-зал 👥500",
};
const ROOM_DISPLAY = {
  "Конференц-зал": "Конференц-зал (стекляшка), до 25 человек 👥",
  "Общий-зал": "Общий-зал, до 70 человек 👥",
  "Актовый-зал": "Актовый-зал, до 500 человек 👥",
};
const WEEK_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS_RU = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
const activeStates = new Map();
let actionLogPurgeTickRunning = false;
let actionLogPurgeExecuteLock = false;

const WORK_HOURS_TEXT = `${String(WORK_START_HOUR).padStart(2, "0")}:00–${String(WORK_END_HOUR).padStart(2, "0")}:00`;

const HELP_TEXT_BASE = [
  "🏢 Бот бронирования помещения",
  "",
  `⏰ Рабочее время организации: ${WORK_HOURS_TEXT} (слоты только в этом интервале).`,
  "• Выбор даты через календарь",
  "• Время начала и окончания шагом 30 минут",
  "• Заявки проходят согласование админа",
  "",
  "💬 Техподдержка: @Crazgr",
  "",
  "Команды:",
  "/start — главное меню",
  "/free_now — свободно сейчас",
  "/weekly_load — загрузка залов за неделю",
].join("\n");

ensureStorage();
const bot = new TelegramBot(token, { polling: true });

bot.onText(/^\/start$/, (msg) => {
  sendMainMenu(msg.chat.id, msg.from.id, "🏠 Главное меню");
});

bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(msg.chat.id, getHelpText(msg.from.id));
});

bot.onText(/^\/free_now$/, (msg) => {
  sendFreeNow(msg.chat.id);
});

bot.onText(/^\/weekly_load$/, (msg) => {
  sendWeeklyLoad(msg.chat.id);
});

bot.onText(/^\/admin$/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "⛔ Админ-панель доступна только администраторам.");
    return;
  }
  sendAdminMenu(msg.chat.id);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const state = activeStates.get(msg.from.id);
  if (!state) {
    sendMainMenu(chatId, msg.from.id, "Используйте меню кнопок:");
    return;
  }

  if (!["full_name", "phone", "purpose"].includes(state.step)) {
    bot.sendMessage(chatId, "Используйте кнопки для выбора даты, времени начала и окончания.");
    return;
  }

  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  if (state.step === "full_name") {
    const fullName = msg.text.trim();
    if (fullName.length < 5) {
      await updateBookingFlowPanel(
        state,
        chatId,
        "⚠️ ФИО слишком короткое (минимум 5 символов).\n\n5/8 Введите ваше ФИО одним сообщением:",
        bookingTextControls()
      );
      return;
    }
    state.data.fullName = fullName;
    state.step = "phone";
    await updateBookingFlowPanel(
      state,
      chatId,
      "6/7 Введите номер телефона для связи (например: +79991234567):",
      bookingTextControls()
    );
    return;
  }

  if (state.step === "phone") {
    const phone = msg.text.trim();
    if (!isValidPhone(phone)) {
      await updateBookingFlowPanel(
        state,
        chatId,
        "⚠️ Некорректный номер. Пример: +79991234567\n\n6/7 Введите номер телефона:",
        bookingTextControls()
      );
      return;
    }
    state.data.phone = phone;
    state.step = "purpose";
    await updateBookingFlowPanel(state, chatId, "7/7 Напишите цель бронирования одним сообщением:", bookingTextControls());
    return;
  }

  const purpose = msg.text.trim();
  if (!purpose) {
    await updateBookingFlowPanel(
      state,
      chatId,
      "⚠️ Цель не может быть пустой.\n\n7/7 Напишите цель бронирования:",
      bookingTextControls()
    );
    return;
  }
  state.data.purpose = purpose;

  state.step = "confirm";
  await updateBookingFlowPanel(state, chatId, buildBookingPreview(state.data), confirmInlineKeyboard());
});

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const msg = query.message;
  const chatId = msg ? msg.chat.id : query.from.id;
  const userId = query.from.id;

  if (data === "menu") {
    const st = activeStates.get(userId);
    if (st) await deleteBookingFlowMessage(st);
    activeStates.delete(userId);
    sendMainMenu(chatId, userId, "🏠 Главное меню");
    return answer(query.id);
  }

  if (data === "menu_help") {
    bot.sendMessage(chatId, getHelpText(userId), {
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]],
      },
    });
    return answer(query.id);
  }

  if (data === "free_now") {
    sendFreeNow(chatId);
    return answer(query.id);
  }

  if (data === "weekly_load") {
    sendWeeklyLoad(chatId);
    return answer(query.id);
  }

  if (data === "noop") {
    return answer(query.id);
  }

  if (data === "book_start") {
    const prev = activeStates.get(userId);
    if (prev) await deleteBookingFlowMessage(prev);
    activeStates.set(userId, {
      step: "pick_room",
      data: { userId, ...userBookingFields(query.from) },
      flowMessageId: null,
      flowChatId: null,
    });
    const state = activeStates.get(userId);
    await updateBookingFlowPanel(
      state,
      chatId,
      "1/5 Выберите помещение (на кнопках — макс. число гостей 👥):",
      roomInlineKeyboard()
    );
    return answer(query.id);
  }

  if (data === "book_back") {
    const state = activeStates.get(userId);
    if (!state) return answer(query.id, "Нет активного бронирования.");
    if (state.step === "phone") {
      state.step = "full_name";
      await updateBookingFlowPanel(state, chatId, "5/8 Введите ваше ФИО одним сообщением:", bookingTextControls());
      return answer(query.id);
    }
    if (state.step === "purpose") {
      state.step = "phone";
      await updateBookingFlowPanel(
        state,
        chatId,
        "6/7 Введите номер телефона для связи (например: +79991234567):",
        bookingTextControls()
      );
      return answer(query.id);
    }
    if (state.step === "confirm") {
      state.step = "purpose";
      await updateBookingFlowPanel(state, chatId, "7/7 Напишите цель бронирования одним сообщением:", bookingTextControls());
      return answer(query.id);
    }
    if (state.step === "full_name") {
      state.step = "pick_end";
      await updateBookingFlowPanel(
        state,
        chatId,
        `4/5 Время окончания (начало ${formatDateTime(state.data.datetime)}, ${formatRoomForDisplay(state.data.room)}). Не позже ${WORK_HOURS_TEXT}:`,
        endTimeInlineKeyboard(state.data.room, state.data.datetime)
      );
      return answer(query.id);
    }
    if (state.step === "pick_end") {
      state.step = "pick_time";
      await updateBookingFlowPanel(
        state,
        chatId,
        `3/5 Время начала для ${state.data.date} (${formatRoomForDisplay(state.data.room)}):`,
        timeInlineKeyboard(state.data.date, state.data.room)
      );
      return answer(query.id);
    }
    if (state.step === "pick_time") {
      state.step = "pick_date";
      const date = state.data.date ? parseDateTime(`${state.data.date} 00:00`) : new Date();
      await updateBookingFlowPanel(
        state,
        chatId,
        "2/5 Выберите дату:",
        calendarInlineKeyboard(date.getFullYear(), date.getMonth() + 1, state.data.date || null)
      );
      return answer(query.id);
    }
    if (state.step === "pick_date") {
      state.step = "pick_room";
      await updateBookingFlowPanel(
        state,
        chatId,
        "1/5 Выберите помещение (на кнопках — макс. число гостей 👥):",
        roomInlineKeyboard()
      );
      return answer(query.id);
    }
    return answer(query.id);
  }

  if (data.startsWith("book_room:")) {
    const state = activeStates.get(userId);
    if (!state) return answer(query.id, "Начните заново через меню.");
    const room = data.replace("book_room:", "");
    if (!ROOM_OPTIONS.includes(room)) return answer(query.id, "Неизвестное помещение.");
    state.data.room = room;
    state.step = "pick_date";
    const today = new Date();
    await updateBookingFlowPanel(
      state,
      chatId,
      "2/5 Выберите дату:",
      calendarInlineKeyboard(today.getFullYear(), today.getMonth() + 1, state.data.date || null)
    );
    return answer(query.id);
  }

  if (data.startsWith("cal_nav:")) {
    const state = activeStates.get(userId);
    if (!state || state.step !== "pick_date" || !msg) return answer(query.id);
    const [yearText, monthText] = data.replace("cal_nav:", "").split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    if (Number.isNaN(year) || Number.isNaN(month)) return answer(query.id);
    if (msg) {
      state.flowMessageId = msg.message_id;
      state.flowChatId = chatId;
    }
    bot
      .editMessageReplyMarkup(calendarInlineKeyboard(year, month, state.data.date || null), {
        chat_id: chatId,
        message_id: msg.message_id,
      })
      .catch(() => {});
    return answer(query.id);
  }

  if (data.startsWith("cal_day:")) {
    const state = activeStates.get(userId);
    if (!state || !state.data.room) return answer(query.id, "Начните заново через меню.");
    const dateText = data.replace("cal_day:", "");
    const dayStart = parseDateTime(`${dateText} 00:00`);
    if (Number.isNaN(dayStart.getTime())) return answer(query.id, "Некорректная дата.");
    state.data.date = dateText;
    state.step = "pick_time";
    if (msg) {
      state.flowMessageId = msg.message_id;
      state.flowChatId = chatId;
    }
    await updateBookingFlowPanel(
      state,
      chatId,
      `3/5 Время для ${dateText} (${formatRoomForDisplay(state.data.room)}):`,
      timeInlineKeyboard(dateText, state.data.room)
    );
    return answer(query.id);
  }

  if (data.startsWith("book_time:")) {
    const state = activeStates.get(userId);
    if (!state || !state.data.date) return answer(query.id, "Сначала выберите дату.");
    const time = data.replace("book_time:", "");
    const datetime = `${state.data.date} ${time}`;
    if (isInPast(datetime)) return answer(query.id, "Это время уже прошло.");
    state.data.datetime = datetime;
    state.step = "pick_end";
    await updateBookingFlowPanel(
      state,
      chatId,
      `4/5 Время окончания (начало ${formatDateTime(datetime)}, ${formatRoomForDisplay(state.data.room)}). Не позже ${WORK_HOURS_TEXT}:`,
      endTimeInlineKeyboard(state.data.room, datetime)
    );
    return answer(query.id, `Начало: ${time}`);
  }

  if (data.startsWith("book_end:")) {
    const state = activeStates.get(userId);
    if (!state || !state.data.datetime) return answer(query.id, "Сначала выберите время начала.");
    const endHm = data.replace("book_end:", "");
    const endDatetime = `${state.data.date} ${endHm}`;
    const startMs = parseDateTime(state.data.datetime).getTime();
    const endMs = parseDateTime(endDatetime).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return answer(query.id, "Некорректное время.");
    if (endMs <= startMs) return answer(query.id, "Окончание должно быть позже начала.");
    const duration = Math.round((endMs - startMs) / 60000);
    if (duration < 30) return answer(query.id, "Минимум 30 минут.");
    if (!isWithinWorkingHoursWithDuration(state.data.datetime, duration)) {
      return answer(query.id, `Интервал выходит за рабочее время организации (${WORK_HOURS_TEXT}).`);
    }
    if (hasApprovedConflict(state.data.room, state.data.datetime, duration)) {
      return answer(query.id, "На это время уже есть подтверждённая бронь.");
    }
    state.data.durationMinutes = duration;
    state.step = "full_name";
    await updateBookingFlowPanel(
      state,
      chatId,
      "5/8 Введите ваше ФИО одним сообщением (текст не будет дублироваться в чате):",
      bookingTextControls()
    );
    return answer(query.id, `До ${endHm}`);
  }

  if (data === "book_submit_yes") {
    const state = activeStates.get(userId);
    if (!state || state.step !== "confirm") return answer(query.id, "Сначала завершите заполнение.");
    if (hasApprovedConflict(state.data.room, state.data.datetime, state.data.durationMinutes)) {
      await deleteBookingFlowMessage(state);
      activeStates.delete(userId);
      bot.sendMessage(chatId, "❌ Пока вы заполняли форму, это время заняли. Создайте заявку заново.");
      sendMainMenu(chatId, userId, "🏠 Главное меню");
      return answer(query.id);
    }
    const booking = addBooking(state.data);
    await deleteBookingFlowMessage(state);
    activeStates.delete(userId);
    bot.sendMessage(
      chatId,
      [
        "✅ Заявка отправлена администратору",
        `ID: ${booking.id}`,
        `Помещение: ${formatRoomForDisplay(booking.room)}`,
        `Время: ${formatRange(booking.datetime, booking.durationMinutes)}`,
        `ФИО: ${booking.fullName}`,
        `Телефон: ${booking.phone}`,
        `Цель: ${booking.purpose}`,
      ].join("\n")
    );
    notifyAdminsForApproval(booking).catch(() => null);
    sendMainMenu(chatId, userId, "Что делаем дальше?");
    return answer(query.id);
  }

  if (data === "book_submit_no") {
    const state = activeStates.get(userId);
    const flowMessageId = state?.flowMessageId;
    const flowChatId = state?.flowChatId;
    activeStates.set(userId, {
      step: "pick_room",
      data: { userId, ...userBookingFields(query.from) },
      flowMessageId,
      flowChatId,
    });
    const newState = activeStates.get(userId);
    await updateBookingFlowPanel(
      newState,
      chatId,
      "Окей, заполним заново.\n1/5 Выберите помещение (на кнопках — макс. число гостей 👥):",
      roomInlineKeyboard()
    );
    return answer(query.id);
  }

  if (data === "my_bookings") {
    sendMyBookings(chatId, userId);
    return answer(query.id);
  }

  if (data === "my_pending") {
    sendMyPending(chatId, userId);
    return answer(query.id);
  }

  if (data === "schedule") {
    sendSchedule(chatId);
    return answer(query.id);
  }

  if (data === "cancel_pick") {
    sendCancelOptions(chatId, userId);
    return answer(query.id);
  }

  if (data.startsWith("cancel:")) {
    const bookingId = Number(data.replace("cancel:", ""));
    const removedBooking = removeBooking(bookingId, userId);
    if (!removedBooking) return answer(query.id, "Бронь не найдена.");
    bot.sendMessage(chatId, `🗑 Бронь #${bookingId} отменена.`);
    notifyAdminsCancelled(removedBooking);
    sendMainMenu(chatId, userId, "Готово.");
    return answer(query.id);
  }

  if (data === "admin_menu") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    sendAdminMenu(chatId);
    return answer(query.id);
  }

  if (data === "admin_list_admins") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    await sendAdminList(chatId);
    return answer(query.id);
  }

  if (data === "admin_pending") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    sendAdminPending(chatId);
    return answer(query.id);
  }

  if (data === "admin_schedule") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    sendAdminSchedule(chatId);
    return answer(query.id);
  }

  if (data === "admin_archive") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    sendAdminArchive(chatId);
    return answer(query.id);
  }

  if (data === "admin_history") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    await sendAdminHistory(chatId);
    return answer(query.id);
  }

  if (data === "admin_export_csv") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    try {
      await sendBookingsCsvExport(chatId);
    } catch (e) {
      console.error("admin_export_csv:", e?.message || e);
      bot.sendMessage(chatId, "Не удалось сформировать файл. Попробуйте позже.");
    }
    return answer(query.id, "Готово");
  }

  if (data === "admin_emergency_purge") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    bot.sendMessage(
      chatId,
      [
        "⚠️ Экстренная очистка журнала действий админов",
        "",
        `1) Всем админам будут отправлены 3 CSV (все брони, журнал действий, архив завершённых броней).`,
        "2) После бэкапа журнал действий админов будет полностью очищен (все записи).",
        "Брони в базе не меняются.",
        "",
        "Подтвердите действие:",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Да, с бэкапом и очисткой", callback_data: "admin_emergency_purge_yes" }],
            [{ text: "⬅ В админ-панель", callback_data: "admin_menu" }],
          ],
        },
      }
    );
    return answer(query.id);
  }

  if (data === "admin_emergency_purge_yes") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    try {
      const r = await runActionLogPurgeWithBackupToAdmins({
        stamp: formatExportFileTimestamp(),
        doneMessageTitle: "Экстренная очистка журнала выполнена.",
        mode: "full",
      });
      if (!r.ok) {
        await bot.sendMessage(chatId, "Сейчас уже выполняется очистка. Подождите ~1 мин и попробуйте снова.", {
          reply_markup: adminNavKeyboard(),
        });
        return answer(query.id);
      }
      await bot.sendMessage(chatId, "Готово: три таблицы отправлены всем админам, журнал действий полностью очищен.", {
        reply_markup: adminNavKeyboard(),
      });
    } catch (e) {
      console.error("admin_emergency_purge_yes:", e?.message || e);
      await bot.sendMessage(chatId, "Ошибка при экстренной очистке. Проверьте логи сервера.", {
        reply_markup: adminNavKeyboard(),
      });
    }
    return answer(query.id, "Выполнено");
  }

  if (data === "admin_delete_pick") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    sendAdminDeleteOptions(chatId);
    return answer(query.id);
  }

  if (data.startsWith("admin_cancel:")) {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    const bookingId = Number(data.replace("admin_cancel:", ""));
    if (Number.isNaN(bookingId)) return answer(query.id, "Некорректный ID.");
    const removedBooking = removeBookingByAdmin(bookingId);
    if (!removedBooking) return answer(query.id, "Бронь не найдена.");
    addAdminActionLog("cancelled", removedBooking, query.from);
    bot.sendMessage(chatId, `🗑 Бронь #${bookingId} удалена администратором.`);
    notifyUserBookingCancelledByAdmin(removedBooking);
    return answer(query.id, "Удалено");
  }

  const [action, idText] = data.split(":");
  if (action === "approve" || action === "reject") {
    if (!isAdmin(userId)) return answer(query.id, "Только для админа.");
    const bookingId = Number(idText);
    const result = updateBookingStatusByAdmin(bookingId, action === "approve" ? "approved" : "rejected");
    if (!result.ok) return answer(query.id, result.message);
    addAdminActionLog(action === "approve" ? "approved" : "rejected", result.booking, query.from);
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    bot.sendMessage(chatId, `Заявка #${bookingId} ${action === "approve" ? "подтверждена ✅" : "отклонена ❌"}.`);
    notifyUserBookingStatus(result.booking, action === "approve" ? "approved" : "rejected");
    if (action === "approve" && Array.isArray(result.autoRejected) && result.autoRejected.length > 0) {
      for (const rejected of result.autoRejected) {
        addAdminActionLog("rejected", rejected, query.from);
        notifyUserBookingStatus(rejected, "rejected_auto_conflict");
      }
      bot.sendMessage(chatId, `Авто-отклонено пересекающихся pending-заявок: ${result.autoRejected.length}.`);
    }
    return answer(query.id);
  }

  return answer(query.id, "Неизвестное действие.");
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

setInterval(() => {
  sendUpcomingReminders().catch((error) => console.error("Reminder error:", error.message));
  cleanupExpiredPending().catch((error) => console.error("Pending cleanup error:", error.message));
  tickActionLogPurge().catch((error) => console.error("Action log purge:", error.message));
}, 30000);

console.log("Telegram booking bot is running...");

function answer(callbackQueryId, text) {
  const promise = !text
    ? bot.answerCallbackQuery(callbackQueryId)
    : bot.answerCallbackQuery(callbackQueryId, { text });

  return promise.catch((error) => {
    const message = error?.message || "";
    if (
      message.includes("query is too old") ||
      message.includes("query ID is invalid") ||
      message.includes("response timeout expired")
    ) {
      return null;
    }
    console.error("answerCallbackQuery error:", message);
    return null;
  });
}

function defaultActionLogPurgeState() {
  return {
    scheduledPurgeAt: new Date(Date.now() + ACTION_LOG_PURGE_INTERVAL_DAYS * 86400000).toISOString(),
    notified24h: false,
    notified2h: false,
  };
}

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKINGS_FILE)) {
    fs.writeFileSync(
      BOOKINGS_FILE,
      JSON.stringify(
        { nextId: 1, bookings: [], actionLog: [], actionLogPurge: defaultActionLogPurgeState() },
        null,
        2
      )
    );
    return;
  }
  migrateStorageIfNeeded();
}

function migrateStorageIfNeeded() {
  const data = readBookings();
  let changed = false;
  if (!Array.isArray(data.actionLog)) {
    data.actionLog = [];
    changed = true;
  }
  for (const booking of data.bookings) {
    if (!booking.status) {
      booking.status = "approved";
      changed = true;
    }
    if (!booking.reminderSentAt) {
      booking.reminderSentAt = null;
      changed = true;
    }
    if (!booking.durationMinutes) {
      booking.durationMinutes = 60;
      changed = true;
    }
  }
  if (!data.actionLogPurge || typeof data.actionLogPurge !== "object") {
    data.actionLogPurge = defaultActionLogPurgeState();
    changed = true;
  } else {
    const p = data.actionLogPurge;
    if (typeof p.scheduledPurgeAt !== "string" || !p.scheduledPurgeAt.trim()) {
      p.scheduledPurgeAt = new Date(Date.now() + ACTION_LOG_PURGE_INTERVAL_DAYS * 86400000).toISOString();
      changed = true;
    }
    if (typeof p.notified24h !== "boolean") {
      p.notified24h = false;
      changed = true;
    }
    if (typeof p.notified2h !== "boolean") {
      p.notified2h = false;
      changed = true;
    }
  }
  if (changed) writeBookings(data);
}

function readBookings() {
  return JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"));
}

function writeBookings(data) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));
}

function csvCellSemicolon(value) {
  const s = value == null ? "" : String(value);
  if (/[;\n\r"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatExportFileTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** UTF-8 с BOM, разделитель «;» — в русском Excel обычно открывается в столбцы без лишних настроек */
function buildBookingsCsvFromList(bookings) {
  const headers = [
    "ID заявки",
    "Статус",
    "Помещение (код в системе)",
    "Помещение",
    "Дата и время начала",
    "Дата и время окончания",
    "ФИО заявителя",
    "Телефон",
    "Цель / мероприятие",
    "Telegram ID заявителя",
    "Заявитель (подпись в боте)",
    "Username в Telegram",
    "Имя из профиля Telegram",
    "Поле username (устар.)",
    "Создано",
    "Обработано админом",
  ];
  const lines = [headers.join(";")];
  const sorted = [...(bookings || [])].sort((a, b) => (a.id < b.id ? 1 : -1));
  for (const b of sorted) {
    lines.push(
      [
        b.id,
        statusLabel(b.status),
        b.room || "",
        formatRoomForDisplay(b.room || ""),
        b.datetime || "",
        formatBookingEndDatetimeForExport(b.datetime, b.durationMinutes),
        b.fullName || "",
        b.phone || "",
        b.purpose || "",
        b.userId ?? "",
        formatUserTag(b),
        b.telegramUsername ?? "",
        b.userChatName ?? "",
        b.username ?? "",
        b.createdAt ?? "",
        b.reviewedAt ?? "",
      ]
        .map(csvCellSemicolon)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

function buildBookingsCsv() {
  return buildBookingsCsvFromList(readBookings().bookings || []);
}

function actionLogActionRu(action) {
  if (action === "approved") return "Подтверждена";
  if (action === "rejected") return "Отклонена";
  if (action === "cancelled") return "Отменена админом";
  return action || "";
}

function buildActionLogCsvFromData(data) {
  const headers = [
    "Дата и время действия",
    "Действие",
    "ID брони",
    "Помещение (код в системе)",
    "Помещение",
    "Цель / мероприятие",
    "Дата и время начала брони",
    "Дата и время окончания брони",
    "Telegram ID заявителя",
    "Заявитель",
    "Telegram ID админа",
    "Администратор",
  ];
  const lines = [headers.join(";")];
  const logs = [...(data.actionLog || [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const e of logs) {
    lines.push(
      [
        e.at || "",
        actionLogActionRu(e.action),
        e.bookingId ?? "",
        e.room || "",
        formatRoomForDisplay(e.room || ""),
        e.purpose || "",
        e.datetime || "",
        formatBookingEndDatetimeForExport(e.datetime, e.durationMinutes),
        e.userId ?? "",
        e.userTag || "",
        e.adminId ?? "",
        e.adminTag || "",
      ]
        .map(csvCellSemicolon)
        .join(";")
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

function buildActionLogCsv() {
  return buildActionLogCsvFromData(readBookings());
}

/**
 * Перед очисткой журнала: всем админам три CSV — как при кнопке «Таблица Excel».
 * @param {string} [journalHint] — что будет с журналом после (по умолчанию текст про retention).
 */
async function sendPurgeBackupCsvToAdmins(stamp, journalHint) {
  const data = readBookings();
  const nBookings = (data.bookings || []).length;
  const nLog = (data.actionLog || []).length;
  const finished = (data.bookings || []).filter((b) => b.status === "approved" && isBookingFinished(b));
  const nFin = finished.length;
  const tmpB = path.join(os.tmpdir(), `broni_backup_pred_ochistkoy_${stamp}.csv`);
  const tmpL = path.join(os.tmpdir(), `istoriya_admina_backup_pred_ochistkoy_${stamp}.csv`);
  const tmpF = path.join(os.tmpdir(), `arhiv_zavershennyh_bron_backup_${stamp}.csv`);
  fs.writeFileSync(tmpB, buildBookingsCsvFromList(data.bookings || []), "utf8");
  fs.writeFileSync(tmpL, buildActionLogCsvFromData(data), "utf8");
  fs.writeFileSync(tmpF, buildBookingsCsvFromList(finished), "utf8");
  try {
    if (ADMIN_USER_IDS.length === 0) {
      console.warn("purge backup: ADMIN_USER_IDS пуст — архив некому отправить");
      return;
    }
    const cap1 = `Архив перед очисткой журнала — файл 1/3: все брони (${nBookings} строк). Сохраните.`;
    const cap2 = `Архив перед очисткой журнала — файл 2/3: история действий админов (${nLog} строк).`;
    const hint =
      journalHint || `Из журнала затем удалятся записи старше ${ACTION_LOG_RETENTION_DAYS} сут.`;
    const cap3 = `Архив перед очисткой журнала — файл 3/3: завершённые брони (${nFin} строк). ${hint}`;
    for (const adminId of ADMIN_USER_IDS) {
      try {
        await bot.sendDocument(adminId, tmpB, { caption: cap1 });
        await bot.sendDocument(adminId, tmpL, { caption: cap2 });
        await bot.sendDocument(adminId, tmpF, { caption: cap3 });
      } catch (e) {
        console.error(`purge backup → admin ${adminId}:`, e?.message || e);
      }
    }
  } finally {
    fs.unlink(tmpB, () => {});
    fs.unlink(tmpL, () => {});
    fs.unlink(tmpF, () => {});
  }
}

/**
 * Три CSV всем админам, затем очистка журнала actionLog и перенос плановой даты.
 * @param {"retention"|"full"} mode — retention: только старше ACTION_LOG_RETENTION_DAYS; full: весь журнал (экстренная очистка).
 * @returns {{ ok: true } | { ok: false, reason: "busy" }}
 */
async function runActionLogPurgeWithBackupToAdmins({ stamp, doneMessageTitle, mode = "retention" }) {
  if (actionLogPurgeExecuteLock) return { ok: false, reason: "busy" };
  actionLogPurgeExecuteLock = true;
  try {
    let data = readBookings();
    if (!data.actionLogPurge || typeof data.actionLogPurge !== "object") {
      data.actionLogPurge = defaultActionLogPurgeState();
      writeBookings(data);
      data = readBookings();
    }
    const now = Date.now();
    await sendPurgeBackupCsvToAdmins(
      stamp,
      mode === "full" ? "После этого весь журнал действий будет удалён." : undefined
    );

    const dataAfter = readBookings();
    let removed;
    if (mode === "full") {
      removed = (dataAfter.actionLog || []).length;
      dataAfter.actionLog = [];
    } else {
      const retentionMs = ACTION_LOG_RETENTION_DAYS * 86400000;
      const cutoff = now - retentionMs;
      const kept = (dataAfter.actionLog || []).filter((e) => {
        const t = actionLogAtMs(e);
        return t != null && t >= cutoff;
      });
      removed = (dataAfter.actionLog || []).length - kept.length;
      dataAfter.actionLog = kept;
    }
    const p = dataAfter.actionLogPurge;
    p.scheduledPurgeAt = new Date(now + ACTION_LOG_PURGE_INTERVAL_DAYS * 86400000).toISOString();
    p.notified24h = false;
    p.notified2h = false;
    writeBookings(dataAfter);

    const nextWhen = new Date(p.scheduledPurgeAt).getTime();
    const detail =
      mode === "full"
        ? `Удалены все записи журнала: ${removed}.`
        : `Удалено устаревших записей в журнале: ${removed}.`;
    const doneMsg = `${doneMessageTitle} ${detail} Следующая плановая очистка (ориентир): ${formatLogDate(new Date(nextWhen).toISOString())}.`;
    for (const adminId of ADMIN_USER_IDS) {
      try {
        await bot.sendMessage(adminId, doneMsg);
      } catch (e) {
        console.error(`purge done msg → ${adminId}:`, e?.message || e);
      }
    }
    return { ok: true };
  } finally {
    actionLogPurgeExecuteLock = false;
  }
}

function actionLogAtMs(entry) {
  const t = new Date(entry?.at).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Плановая очистка журнала: напоминания за 24 ч и 2 ч, затем CSV и удаление записей старше retention */
async function tickActionLogPurge() {
  if (actionLogPurgeTickRunning) return;
  actionLogPurgeTickRunning = true;
  try {
    const data = readBookings();
    const p = data.actionLogPurge;
    if (!p || typeof p !== "object") return;

    const now = Date.now();
    let when = new Date(p.scheduledPurgeAt).getTime();
    if (Number.isNaN(when)) {
      p.scheduledPurgeAt = new Date(now + ACTION_LOG_PURGE_INTERVAL_DAYS * 86400000).toISOString();
      p.notified24h = false;
      p.notified2h = false;
      writeBookings(data);
      return;
    }

    const msToPurge = when - now;

    if (now >= when) {
      const stamp = formatExportFileTimestamp();
      const r = await runActionLogPurgeWithBackupToAdmins({
        stamp,
        doneMessageTitle: "Плановая очистка истории действий выполнена.",
        mode: "retention",
      });
      if (!r.ok) {
        console.warn("Плановая очистка: занято, повтор в следующем тике.");
      }
      return;
    }

    const h2 = 2 * 3600000;
    const h24 = 24 * 3600000;

    if (msToPurge <= h2 && msToPurge > 0 && !p.notified2h) {
      p.notified2h = true;
      writeBookings(data);
      const msg = `⏳ До плановой очистки журнала действий осталось около двух часов.\n\nИз журнала удалятся записи старше ${ACTION_LOG_RETENTION_DAYS} сут. Перед удалением бот пришлёт три CSV (как «Таблица Excel»): все брони, история действий и архив завершённых броней.\n\nМомент очистки (время организации): ${formatLogDate(new Date(when).toISOString())}`;
      for (const adminId of ADMIN_USER_IDS) {
        try {
          await bot.sendMessage(adminId, msg);
        } catch (e) {
          console.error(`purge 2h → ${adminId}:`, e?.message || e);
        }
      }
      return;
    }

    if (msToPurge <= h24 && msToPurge > h2 && !p.notified24h) {
      p.notified24h = true;
      writeBookings(data);
      const msg = `📅 Скоро плановая очистка журнала действий админов.\n\nЗаписи старше ${ACTION_LOG_RETENTION_DAYS} сут будут удалены из журнала. За ~2 часа — ещё напоминание; в момент очистки — три CSV (все брони, журнал, архив завершённых).\n\nМомент очистки (время организации): ${formatLogDate(new Date(when).toISOString())}`;
      for (const adminId of ADMIN_USER_IDS) {
        try {
          await bot.sendMessage(adminId, msg);
        } catch (e) {
          console.error(`purge 24h → ${adminId}:`, e?.message || e);
        }
      }
    }
  } finally {
    actionLogPurgeTickRunning = false;
  }
}

async function sendBookingsCsvExport(chatId) {
  const data = readBookings();
  const n = (data.bookings || []).length;
  const m = (data.actionLog || []).length;
  const finished = (data.bookings || []).filter((b) => b.status === "approved" && isBookingFinished(b));
  const k = finished.length;
  const stamp = formatExportFileTimestamp();
  const tmpBookings = path.join(os.tmpdir(), `broni_${stamp}.csv`);
  const tmpLog = path.join(os.tmpdir(), `istoriya_admina_${stamp}.csv`);
  const tmpFinished = path.join(os.tmpdir(), `arhiv_zavershennyh_bron_${stamp}.csv`);
  fs.writeFileSync(tmpBookings, buildBookingsCsv(), "utf8");
  fs.writeFileSync(tmpLog, buildActionLogCsv(), "utf8");
  fs.writeFileSync(tmpFinished, buildBookingsCsvFromList(finished), "utf8");
  try {
    await bot.sendDocument(chatId, tmpBookings, {
      caption: `Файл 1 из 3: все брони (${n} строк). Заголовки на русском. Разделитель «;», UTF-8.`,
    });
    await bot.sendDocument(chatId, tmpLog, {
      caption: `Файл 2 из 3: история действий админов (${m} строк). Тот же формат.`,
    });
    await bot.sendDocument(chatId, tmpFinished, {
      caption: `Файл 3 из 3: архив завершённых броней (${k} строк): подтверждённые, время мероприятия уже прошло.`,
    });
  } finally {
    fs.unlink(tmpBookings, () => {});
    fs.unlink(tmpLog, () => {});
    fs.unlink(tmpFinished, () => {});
  }
}

function userBookingFields(from) {
  const telegramUsername = from.username ? String(from.username).replace(/^@/, "") : null;
  const userChatName =
    [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || null;
  return { telegramUsername, userChatName };
}

function addBooking(input) {
  const data = readBookings();
  const booking = {
    id: data.nextId++,
    userId: input.userId,
    telegramUsername: input.telegramUsername || null,
    userChatName: input.userChatName || null,
    /** устар.: для старых записей и запасного отображения */
    username: input.telegramUsername || input.userChatName || "unknown",
    room: input.room,
    datetime: input.datetime,
    durationMinutes: input.durationMinutes,
    fullName: input.fullName,
    phone: input.phone,
    purpose: input.purpose,
    status: "pending",
    reminderSentAt: null,
    createdAt: new Date().toISOString(),
  };
  data.bookings.push(booking);
  writeBookings(data);
  return booking;
}

function removeBooking(id, userId) {
  const data = readBookings();
  const idx = data.bookings.findIndex((b) => b.id === id && b.userId === userId && (b.status === "pending" || b.status === "approved"));
  if (idx === -1) return null;
  const [removed] = data.bookings.splice(idx, 1);
  writeBookings(data);
  return removed;
}

function removeBookingByAdmin(id) {
  const data = readBookings();
  const idx = data.bookings.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const [removed] = data.bookings.splice(idx, 1);
  writeBookings(data);
  return removed;
}

function hasApprovedConflict(room, datetime, durationMinutes) {
  const data = readBookings();
  const start = parseDateTime(datetime);
  return data.bookings.some((b) => {
    if (b.room !== room || b.status !== "approved") return false;
    return areOverlapping(start, durationMinutes, parseDateTime(b.datetime), b.durationMinutes || 60);
  });
}

function updateBookingStatusByAdmin(id, newStatus) {
  const data = readBookings();
  const booking = data.bookings.find((b) => b.id === id);
  if (!booking) return { ok: false, message: "Бронь не найдена." };
  if (booking.status !== "pending") return { ok: false, message: "Эта заявка уже обработана." };
  if (newStatus === "approved" && hasApprovedConflict(booking.room, booking.datetime, booking.durationMinutes || 60)) {
    return { ok: false, message: "Слот уже занят подтвержденной бронью." };
  }
  booking.status = newStatus;
  booking.reviewedAt = new Date().toISOString();
  const autoRejected = [];

  if (newStatus === "approved") {
    const approvedStart = parseDateTime(booking.datetime);
    const approvedDuration = booking.durationMinutes || 60;
    for (const candidate of data.bookings) {
      if (candidate.id === booking.id) continue;
      if (candidate.status !== "pending") continue;
      if (candidate.room !== booking.room) continue;
      const overlap = areOverlapping(
        approvedStart,
        approvedDuration,
        parseDateTime(candidate.datetime),
        candidate.durationMinutes || 60
      );
      if (!overlap) continue;
      candidate.status = "rejected";
      candidate.reviewedAt = new Date().toISOString();
      candidate.rejectReason = "auto_conflict_after_approval";
      autoRejected.push(candidate);
    }
  }

  writeBookings(data);
  return { ok: true, booking, autoRejected };
}

async function notifyAdminsForApproval(booking) {
  for (const adminId of ADMIN_USER_IDS) {
    await bot.sendMessage(
      adminId,
      [
        "🔔 Новая заявка",
        `ID: ${booking.id}`,
        `Пользователь: ${formatUserTag(booking)}`,
        `ФИО: ${booking.fullName}`,
        `Телефон: ${booking.phone}`,
        `Помещение: ${formatRoomForDisplay(booking.room)}`,
        `Время: ${formatRange(booking.datetime, booking.durationMinutes)}`,
        `Цель: ${booking.purpose}`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Подтвердить", callback_data: `approve:${booking.id}` },
            { text: "❌ Отклонить", callback_data: `reject:${booking.id}` },
          ]],
        },
      }
    );
  }
}

async function notifyAdminsCancelled(booking) {
  for (const adminId of ADMIN_USER_IDS) {
    await bot.sendMessage(adminId, `Пользователь ${formatUserTag(booking)} отменил бронь #${booking.id}.`);
  }
}

async function notifyUserBookingCancelledByAdmin(booking) {
  const text = [
    `❌ Ваша бронь #${booking.id} была отменена администратором.`,
    `${formatRoomForDisplay(booking.room)} | ${formatRange(booking.datetime, booking.durationMinutes)}`,
  ].join("\n");
  await bot.sendMessage(booking.userId, text);
}

async function notifyUserBookingStatus(booking, status) {
  let text;
  if (status === "approved") {
    text = `✅ Ваша бронь #${booking.id} подтверждена.\n${formatRoomForDisplay(booking.room)} | ${formatRange(booking.datetime, booking.durationMinutes)}`;
  } else if (status === "rejected_auto_conflict") {
    text = `❌ Ваша заявка #${booking.id} отклонена автоматически, потому что пересекается с уже подтвержденной бронью.\n${formatRoomForDisplay(booking.room)} | ${formatRange(
      booking.datetime,
      booking.durationMinutes
    )}`;
  } else {
    text = `❌ Ваша бронь #${booking.id} отклонена.\n${formatRoomForDisplay(booking.room)} | ${formatRange(booking.datetime, booking.durationMinutes)}`;
  }
  await bot.sendMessage(booking.userId, text);
}

async function sendUpcomingReminders() {
  const data = readBookings();
  let changed = false;
  const now = Date.now();

  for (const booking of data.bookings) {
    if (booking.status !== "approved" || booking.reminderSentAt) continue;
    const diffMs = parseDateTime(booking.datetime).getTime() - now;
    if (diffMs <= REMINDER_MINUTES_BEFORE * 60000 && diffMs > 0) {
      await bot.sendMessage(
        booking.userId,
        `⏰ Напоминание: через ${REMINDER_MINUTES_BEFORE} мин начинается бронь #${booking.id} (${formatRoomForDisplay(booking.room)}, ${formatRange(
          booking.datetime,
          booking.durationMinutes
        )}).`
      );
      booking.reminderSentAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) writeBookings(data);
}

async function cleanupExpiredPending() {
  const data = readBookings();
  const now = Date.now();
  const ttlMs = PENDING_TTL_HOURS * 60 * 60 * 1000;
  const expired = data.bookings.filter((b) => b.status === "pending" && new Date(b.createdAt).getTime() + ttlMs <= now);
  if (expired.length === 0) return;

  data.bookings = data.bookings.filter((b) => !(b.status === "pending" && new Date(b.createdAt).getTime() + ttlMs <= now));
  writeBookings(data);

  for (const b of expired) {
    await bot
      .sendMessage(
        b.userId,
        `⌛ Ваша заявка #${b.id} автоматически закрыта, потому что не была подтверждена в течение ${PENDING_TTL_HOURS} часов.`
      )
      .catch(() => null);
  }
}

function orgWallHourMinute(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BOOKING_TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { hour, minute };
}

function orgEndHourCeil(utcMs) {
  const { hour, minute } = orgWallHourMinute(utcMs);
  if (Number.isNaN(hour)) return NaN;
  return hour + (minute > 0 ? 1 : 0);
}

function isWithinWorkingHoursWithDuration(datetimeText, durationMinutes) {
  const start = parseDateTime(datetimeText);
  const startMs = start.getTime();
  if (Number.isNaN(startMs)) return false;
  const end = new Date(startMs + durationMinutes * 60000);
  const startHour = orgWallHourMinute(startMs).hour;
  const endHour = orgEndHourCeil(end.getTime());
  return startHour >= WORK_START_HOUR && endHour <= WORK_END_HOUR;
}

function isInPast(datetimeText) {
  return parseDateTime(datetimeText).getTime() <= Date.now();
}

function parseDateTime(datetimeText) {
  const raw = String(datetimeText || "").trim();
  if (!raw) return new Date(NaN);
  let iso = raw.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso)) iso = `${iso}:00`;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) return new Date(iso);
  return new Date(`${iso}${BOOKING_LOCAL_OFFSET}`);
}

function formatDateTime(datetimeText) {
  if (datetimeText == null || String(datetimeText).trim() === "") return "—";
  return String(datetimeText).replace(" ", " в ");
}

function formatRange(datetimeText, durationMinutes) {
  const end = new Date(parseDateTime(datetimeText).getTime() + (durationMinutes || 60) * 60000);
  return `${formatDateTime(datetimeText)} - ${toHHMM(end)}`;
}

/** Для журнала админа: нет падения на старых/битых записях без datetime */
function formatRangeSafe(datetimeText, durationMinutes) {
  if (datetimeText == null || String(datetimeText).trim() === "") return "—";
  const startMs = parseDateTime(String(datetimeText)).getTime();
  if (Number.isNaN(startMs)) return "—";
  try {
    return formatRange(String(datetimeText), durationMinutes);
  } catch {
    return "—";
  }
}

function toHHMM(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BOOKING_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

/** Для экспорта: окончание брони в часовом поясе организации (как в боте). */
function formatBookingEndDatetimeForExport(datetimeText, durationMinutes) {
  const startMs = parseDateTime(datetimeText).getTime();
  if (Number.isNaN(startMs)) return "";
  const dur = durationMinutes ?? 60;
  const end = new Date(startMs + dur * 60000);
  if (Number.isNaN(end.getTime())) return "";
  const datePart = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(end);
  return `${datePart} ${toHHMM(end)}`;
}

function statusLabel(status) {
  if (status === "approved") return "подтверждена";
  if (status === "rejected") return "отклонена";
  return "ожидает подтверждения";
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function formatRoomForDisplay(storedRoom) {
  return ROOM_DISPLAY[storedRoom] || storedRoom;
}

function roomButtonLabel(storedRoom) {
  return ROOM_BUTTON_LABEL[storedRoom] || storedRoom;
}

/** Одно «панельное» сообщение мастера бронирования — правим его, чтобы не засорять чат. */
async function deleteBookingFlowMessage(state) {
  if (!state?.flowMessageId || !state?.flowChatId) return;
  await bot.deleteMessage(state.flowChatId, state.flowMessageId).catch(() => {});
  state.flowMessageId = null;
  state.flowChatId = null;
}

async function updateBookingFlowPanel(state, chatId, text, replyMarkup) {
  const opts = { reply_markup: replyMarkup };
  if (state.flowMessageId && state.flowChatId === chatId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: state.flowMessageId,
        ...opts,
      });
      return;
    } catch (_) {
      /* сообщение слишком старое или то же содержимое — шлём новое */
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  state.flowMessageId = sent.message_id;
  state.flowChatId = chatId;
}

function toHour(input, fallback) {
  const value = Number(input);
  if (Number.isNaN(value) || value < 0 || value > 23) return fallback;
  return value;
}

function toPositiveInt(input, fallback) {
  const value = Number(input);
  if (Number.isNaN(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function areOverlapping(startA, durA, startB, durB) {
  const endA = new Date(startA.getTime() + durA * 60000);
  const endB = new Date(startB.getTime() + durB * 60000);
  return startA < endB && startB < endA;
}

function sendMainMenu(chatId, userId, title) {
  const rows = [
    [{ text: "📅 Создать бронь", callback_data: "book_start" }],
    [
      { text: "🟢 Свободно сейчас", callback_data: "free_now" },
      { text: "📊 Загрузка за неделю", callback_data: "weekly_load" },
    ],
    [
      { text: "📋 Мои брони", callback_data: "my_bookings" },
      { text: "🕓 Мои заявки", callback_data: "my_pending" },
    ],
    [
      { text: "🗓 Расписание", callback_data: "schedule" },
      { text: "🗑 Отменить", callback_data: "cancel_pick" },
    ],
    [{ text: "ℹ️ Помощь", callback_data: "menu_help" }],
  ];
  if (isAdmin(userId)) rows.push([{ text: "🛠 Админ-панель", callback_data: "admin_menu" }]);
  bot.sendMessage(chatId, title, { reply_markup: { inline_keyboard: rows } });
}

function sendAdminMenu(chatId) {
  bot.sendMessage(chatId, "🛠 Админ-панель", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⏳ Заявки на согласование", callback_data: "admin_pending" }],
        [{ text: "🗓 Подтвержденное расписание", callback_data: "admin_schedule" }],
        [{ text: "🗂 Архив завершенных броней", callback_data: "admin_archive" }],
        [{ text: "🗑 Удалить бронь пользователя", callback_data: "admin_delete_pick" }],
        [{ text: "📜 История действий", callback_data: "admin_history" }],
        [{ text: "📥 Таблица Excel (CSV)", callback_data: "admin_export_csv" }],
        [{ text: "👥 Список админов", callback_data: "admin_list_admins" }],
        [{ text: "🚨 Экстренная очистка журнала", callback_data: "admin_emergency_purge" }],
        [{ text: "🏠 В главное меню", callback_data: "menu" }],
      ],
    },
  });
}

async function sendAdminList(chatId) {
  if (ADMIN_USER_IDS.length === 0) {
    await bot.sendMessage(chatId, "Админов нет: в настройках бота пустой ADMIN_USER_IDS.", {
      reply_markup: adminNavKeyboard(),
    });
    return;
  }
  const lines = [];
  for (let i = 0; i < ADMIN_USER_IDS.length; i += 1) {
    const id = ADMIN_USER_IDS[i];
    try {
      const ch = await bot.getChat(id);
      const un = ch.username ? `@${String(ch.username).replace(/^@/, "")}` : null;
      const name = [ch.first_name, ch.last_name].filter(Boolean).join(" ").trim() || null;
      if (un) lines.push(`${i + 1}) ${un} · ID ${id}`);
      else if (name) lines.push(`${i + 1}) ${name} · ID ${id} (username не указан в Telegram)`);
      else lines.push(`${i + 1}) ID ${id} (имя недоступно)`);
    } catch {
      lines.push(`${i + 1}) ID ${id} — профиль недоступен (пользователь ещё не писал боту в личку)`);
    }
  }
  const text = [
    "👥 Администраторы по списку ADMIN_USER_IDS:",
    "",
    ...lines,
    "",
    "Подпись @username видна, если у человека он задан и бот уже «видел» этот чат (например, после /start).",
  ].join("\n");
  await bot.sendMessage(chatId, text, { reply_markup: adminNavKeyboard() });
}

function roomInlineKeyboard() {
  const rows = ROOM_OPTIONS.map((room) => [
    { text: roomButtonLabel(room), callback_data: `book_room:${room}` },
  ]);
  rows.push([{ text: "🏠 В меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function calendarInlineKeyboard(year, month, selectedDate) {
  const today = startOfDay(new Date());
  const first = new Date(year, month - 1, 1);
  const firstWeekday = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = [];

  rows.push([
    { text: "« Год", callback_data: `cal_nav:${year - 1}-${month}` },
    { text: `${MONTHS_RU[month - 1]} ${year}`, callback_data: "noop" },
    { text: "Год »", callback_data: `cal_nav:${year + 1}-${month}` },
  ]);
  rows.push(WEEK_DAYS.map((w) => ({ text: w, callback_data: "noop" })));

  let day = 1;
  for (let week = 0; week < 6; week += 1) {
    const row = [];
    for (let wd = 0; wd < 7; wd += 1) {
      if ((week === 0 && wd < firstWeekday) || day > daysInMonth) {
        row.push({ text: " ", callback_data: "noop" });
        continue;
      }
      const date = new Date(year, month - 1, day);
      const dateText = formatDate(date);
      let text = `${day}`;
      if (startOfDay(date).getTime() < today.getTime()) {
        row.push({ text: `·${text}`, callback_data: "noop" });
      } else {
        if (selectedDate && selectedDate === dateText) {
          text = `[${day}]`;
        }
        row.push({ text, callback_data: `cal_day:${dateText}` });
      }
      day += 1;
    }
    rows.push(row);
    if (day > daysInMonth) break;
  }

  const prev = new Date(year, month - 2, 1);
  const next = new Date(year, month, 1);
  rows.push([
    { text: "◀", callback_data: `cal_nav:${prev.getFullYear()}-${prev.getMonth() + 1}` },
    { text: "Сегодня", callback_data: `cal_day:${formatDate(today)}` },
    { text: "▶", callback_data: `cal_nav:${next.getFullYear()}-${next.getMonth() + 1}` },
  ]);
  rows.push([
    { text: "⬅ Назад", callback_data: "book_back" },
    { text: "🏠 В меню", callback_data: "menu" },
  ]);
  return { inline_keyboard: rows };
}

function hasAnyAvailableEndSlot(room, startDatetime) {
  const datePart = startDatetime.split(" ")[0];
  const startMs = parseDateTime(startDatetime).getTime();
  if (Number.isNaN(startMs)) return false;
  const closeMs = parseDateTime(`${datePart} ${String(WORK_END_HOUR).padStart(2, "0")}:00`).getTime();
  if (Number.isNaN(closeMs)) return false;
  for (let endMs = startMs + 30 * 60000; endMs <= closeMs; endMs += 30 * 60000) {
    const duration = Math.round((endMs - startMs) / 60000);
    if (!isWithinWorkingHoursWithDuration(startDatetime, duration)) continue;
    if (!hasApprovedConflict(room, startDatetime, duration)) return true;
  }
  return false;
}

function timeInlineKeyboard(dateText, room) {
  const rows = [];
  const times = [];
  for (let hour = WORK_START_HOUR; hour < WORK_END_HOUR; hour += 1) {
    times.push(`${`${hour}`.padStart(2, "0")}:00`);
    times.push(`${`${hour}`.padStart(2, "0")}:30`);
  }

  const available = times.filter((time) => {
    const datetime = `${dateText} ${time}`;
    if (isInPast(datetime)) return false;
    return hasAnyAvailableEndSlot(room, datetime);
  });
  for (let i = 0; i < available.length; i += 3) {
    rows.push(
      available.slice(i, i + 3).map((time) => ({
        text: time,
        callback_data: `book_time:${time}`,
      }))
    );
  }
  if (rows.length === 0) rows.push([{ text: "Нет свободных слотов", callback_data: "noop" }]);
  rows.push([
    { text: "⬅ Назад", callback_data: "book_back" },
    { text: "🏠 В меню", callback_data: "menu" },
  ]);
  return { inline_keyboard: rows };
}

function endTimeInlineKeyboard(room, startDatetime) {
  const datePart = startDatetime.split(" ")[0];
  const startMs = parseDateTime(startDatetime).getTime();
  const rows = [];
  if (Number.isNaN(startMs)) {
    rows.push([{ text: "Ошибка времени", callback_data: "noop" }]);
  } else {
    const closeMs = parseDateTime(`${datePart} ${String(WORK_END_HOUR).padStart(2, "0")}:00`).getTime();
    const ends = [];
    for (let endMs = startMs + 30 * 60000; endMs <= closeMs; endMs += 30 * 60000) {
      const duration = Math.round((endMs - startMs) / 60000);
      if (!isWithinWorkingHoursWithDuration(startDatetime, duration)) continue;
      if (hasApprovedConflict(room, startDatetime, duration)) continue;
      ends.push(toHHMM(new Date(endMs)));
    }
    for (let i = 0; i < ends.length; i += 3) {
      rows.push(
        ends.slice(i, i + 3).map((hm) => ({
          text: `до ${hm}`,
          callback_data: `book_end:${hm}`,
        }))
      );
    }
    if (rows.length === 0) rows.push([{ text: "Нет свободного окончания", callback_data: "noop" }]);
  }
  rows.push([
    { text: "⬅ Назад", callback_data: "book_back" },
    { text: "🏠 В меню", callback_data: "menu" },
  ]);
  return { inline_keyboard: rows };
}

function sendMyBookings(chatId, userId) {
  const data = readBookings();
  const myBookings = data.bookings.filter((b) => b.userId === userId);
  if (myBookings.length === 0) return bot.sendMessage(chatId, "У вас пока нет броней.", { reply_markup: userNavKeyboard() });
  const text = myBookings
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1))
    .map(
      (b, i) =>
        `${i + 1}) 📅 ${formatRange(b.datetime, b.durationMinutes)}\n🏢 Помещение: ${formatRoomForDisplay(b.room)}\n🎯 Мероприятие: ${
          b.purpose
        }\n📌 Статус: ${statusLabel(b.status)}`
    )
    .join("\n\n");
  bot.sendMessage(chatId, `📋 Ваши брони:\n\n${text}`, { reply_markup: userNavKeyboard() });
}

function sendMyPending(chatId, userId) {
  const data = readBookings();
  const pending = data.bookings.filter((b) => b.userId === userId && b.status === "pending");
  if (pending.length === 0) return bot.sendMessage(chatId, "У вас нет заявок на согласовании.", { reply_markup: userNavKeyboard() });
  const text = pending
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1))
    .map(
      (b, i) =>
        `${i + 1}) 📅 ${formatRange(b.datetime, b.durationMinutes)}\n🏢 Помещение: ${formatRoomForDisplay(b.room)}\n🎯 Мероприятие: ${
          b.purpose
        }\n📌 Статус: ожидает подтверждения`
    )
    .join("\n\n");
  bot.sendMessage(chatId, `🕓 Ваши заявки:\n\n${text}`, { reply_markup: userNavKeyboard() });
}

function sendSchedule(chatId) {
  const data = readBookings();
  const sorted = data.bookings
    .filter((b) => b.status === "approved" && !isBookingFinished(b))
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  if (sorted.length === 0) return bot.sendMessage(chatId, "Сейчас нет активных и будущих броней.", { reply_markup: userNavKeyboard() });
  const text = sorted
    .map(
      (b, i) =>
        `${i + 1}) 📅 ${formatRange(b.datetime, b.durationMinutes)}\n🏢 Помещение: ${formatRoomForDisplay(b.room)}\n🎯 Мероприятие: ${b.purpose || "-"}`
    )
    .join("\n\n");
  bot.sendMessage(chatId, `🗓 Расписание бронирований:\n\n${text}`, { reply_markup: userNavKeyboard() });
}

function sendAdminSchedule(chatId) {
  const data = readBookings();
  const sorted = data.bookings
    .filter((b) => b.status === "approved" && !isBookingFinished(b))
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  if (sorted.length === 0) return bot.sendMessage(chatId, "Нет активных подтвержденных броней.", { reply_markup: adminNavKeyboard() });
  const text = sorted
    .map(
      (b) =>
        `#${b.id} | ${formatRange(b.datetime, b.durationMinutes)} | ${formatRoomForDisplay(b.room)}\nЮзер: ${formatUserTag(b)} (ID: ${b.userId})\nФИО: ${b.fullName || "-"} | Тел: ${b.phone || "-"}\n🎯 Мероприятие: ${b.purpose || "-"}`
    )
    .join("\n\n");
  bot.sendMessage(chatId, `🗓 Подтвержденное расписание (админ):\n\n${text}`, { reply_markup: adminNavKeyboard() });
}

function sendAdminArchive(chatId) {
  const data = readBookings();
  const archived = data.bookings
    .filter((b) => b.status === "approved" && isBookingFinished(b))
    .sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
  if (archived.length === 0) {
    bot.sendMessage(chatId, "Архив завершенных броней пока пуст.", { reply_markup: adminNavKeyboard() });
    return;
  }
  const text = archived
    .slice(0, 50)
    .map(
      (b) =>
        `#${b.id} | ${formatRange(b.datetime, b.durationMinutes)} | ${formatRoomForDisplay(b.room)}\nЮзер: ${formatUserTag(b)} (ID: ${b.userId})\nФИО: ${b.fullName || "-"} | Тел: ${b.phone || "-"}\n🎯 Мероприятие: ${b.purpose || "-"}`
    )
    .join("\n\n");
  bot.sendMessage(chatId, `🗂 Архив завершенных броней:\n\n${text}`, { reply_markup: adminNavKeyboard() });
}

function sendCancelOptions(chatId, userId) {
  const data = readBookings();
  const myBookings = data.bookings
    .filter((b) => b.userId === userId && (b.status === "pending" || b.status === "approved"))
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  if (myBookings.length === 0) return bot.sendMessage(chatId, "У вас нет активных броней для отмены.", { reply_markup: userNavKeyboard() });
  const rows = myBookings.map((b) => [
    { text: `#${b.id} ${roomButtonLabel(b.room)} ${formatDateTime(b.datetime)}`, callback_data: `cancel:${b.id}` },
  ]);
  rows.push([
    { text: "⬅ Назад", callback_data: "menu" },
    { text: "🏠 Главное меню", callback_data: "menu" },
  ]);
  bot.sendMessage(chatId, "Выберите бронь для отмены:", { reply_markup: { inline_keyboard: rows } });
}

function sendAdminPending(chatId) {
  const data = readBookings();
  const pending = data.bookings.filter((b) => b.status === "pending").sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  if (pending.length === 0) return bot.sendMessage(chatId, "Нет заявок на подтверждение.", { reply_markup: adminNavKeyboard() });
  for (const b of pending) {
    const text = [
      `ID: ${b.id}`,
      `Пользователь: ${formatUserTag(b)} (ID: ${b.userId})`,
      `ФИО: ${b.fullName || "-"}`,
      `Телефон: ${b.phone || "-"}`,
      `Помещение: ${formatRoomForDisplay(b.room)}`,
      `Время: ${formatRange(b.datetime, b.durationMinutes)}`,
      `Цель: ${b.purpose}`,
    ].join("\n");
    bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Подтвердить", callback_data: `approve:${b.id}` },
          { text: "❌ Отклонить", callback_data: `reject:${b.id}` },
        ], ...adminNavKeyboard().inline_keyboard],
      },
    });
  }
}

function sendAdminDeleteOptions(chatId) {
  const data = readBookings();
  const activeBookings = data.bookings
    .filter((b) => b.status === "pending" || (b.status === "approved" && !isBookingFinished(b)))
    .sort((a, b) => (a.datetime > b.datetime ? 1 : -1));
  if (activeBookings.length === 0) {
    bot.sendMessage(chatId, "Нет броней для удаления.", { reply_markup: adminNavKeyboard() });
    return;
  }
  const rows = activeBookings.map((b) => [
    {
      text: `#${b.id} ${b.room} ${formatDateTime(b.datetime)} (${formatUserTag(b)})`,
      callback_data: `admin_cancel:${b.id}`,
    },
  ]);
  rows.push(...adminNavKeyboard().inline_keyboard);
  bot.sendMessage(chatId, "Выберите бронь для удаления:", {
    reply_markup: { inline_keyboard: rows },
  });
}

function sendFreeNow(chatId) {
  const now = new Date();
  const items = ROOM_OPTIONS.map((room) => {
    const active = getActiveBookingForRoom(room, now);
    if (!active) {
      return `🟢 ${formatRoomForDisplay(room)}: свободно`;
    }
    const end = new Date(parseDateTime(active.datetime).getTime() + (active.durationMinutes || 60) * 60000);
    return `🔴 ${formatRoomForDisplay(room)}: занято до ${toHHMM(end)} (${active.purpose || "мероприятие"})`;
  });

  const text = [`Статус залов на сейчас (${formatLogDate(now.toISOString())}):`, "", ...items].join("\n");
  bot.sendMessage(chatId, text, { reply_markup: userNavKeyboard() });
}

function sendWeeklyLoad(chatId) {
  const data = readBookings();
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const approved = data.bookings.filter((b) => b.status === "approved");

  const totals = ROOM_OPTIONS.map((room) => ({ room, minutes: 0, bookings: 0 }));
  for (const b of approved) {
    const start = parseDateTime(b.datetime).getTime();
    if (start < weekAgo || start > now) continue;
    const item = totals.find((x) => x.room === b.room);
    if (!item) continue;
    item.minutes += b.durationMinutes || 60;
    item.bookings += 1;
  }

  const sorted = totals.sort((a, b) => b.minutes - a.minutes);
  const totalMinutesAll = sorted.reduce((acc, x) => acc + x.minutes, 0);
  const lines = sorted.map((x, i) => {
    const share = totalMinutesAll > 0 ? Math.round((x.minutes / totalMinutesAll) * 100) : 0;
    return `${i + 1}) ${formatRoomForDisplay(x.room)}\n   Броней: ${x.bookings}\n   Занято: ${x.minutes} мин (${share}%)`;
  });

  const text =
    totalMinutesAll === 0
      ? "За последние 7 дней подтвержденных броней нет."
      : `📊 Рейтинг загрузки залов за последние 7 дней:\n\n${lines.join("\n\n")}`;
  bot.sendMessage(chatId, text, { reply_markup: userNavKeyboard() });
}

function getActiveBookingForRoom(room, date) {
  const data = readBookings();
  const nowMs = date.getTime();
  const approved = data.bookings.filter((b) => b.status === "approved" && b.room === room);
  for (const b of approved) {
    const start = parseDateTime(b.datetime).getTime();
    const end = start + (b.durationMinutes || 60) * 60000;
    if (nowMs >= start && nowMs < end) {
      return b;
    }
  }
  return null;
}

async function sendAdminHistory(chatId) {
  const data = readBookings();
  const retentionMs = ACTION_LOG_RETENTION_DAYS * 86400000;
  const logCutoff = Date.now() - retentionMs;
  /** Только записи не старше retention; в файле новые в начале — берём 30 последних среди «свежих», в чате: старые сверху */
  const recent = (data.actionLog || []).filter((e) => {
    const t = actionLogAtMs(e);
    return t != null && t >= logCutoff;
  });
  const logs = recent.slice(0, 30).reverse();
  if (logs.length === 0) {
    await bot.sendMessage(
      chatId,
      `За последние ${ACTION_LOG_RETENTION_DAYS} сут. в журнале нет записей. Более старые удаляются при плановой очистке (перед ней бот присылает CSV админам).`,
      { reply_markup: adminNavKeyboard() }
    );
    return;
  }
  const purposeLine = (p) => {
    const s = p == null ? "" : String(p).trim();
    if (!s) return "—";
    const max = 200;
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  };
  const formatEntry = (entry, i) => {
    const actionLabel =
      entry.action === "approved" ? "подтвердил" : entry.action === "rejected" ? "отклонил" : "отменил";
    return `${i + 1}) ${formatLogDate(entry.at)}
Админ: ${entry.adminTag ?? "-"} (ID: ${entry.adminId ?? "-"})
Действие: ${actionLabel} бронь #${entry.bookingId}
Помещение: ${formatRoomForDisplay(entry.room || "")}
Мероприятие: ${purposeLine(entry.purpose)}
Время: ${formatRangeSafe(entry.datetime, entry.durationMinutes)}
Пользователь: ${entry.userTag ?? "-"} (ID: ${entry.userId ?? "-"})`;
  };
  /** Несколько сообщений: лимит Telegram 4096 символов, 30 записей не помещаются в одно */
  const perMessage = 8;
  try {
    for (let start = 0; start < logs.length; start += perMessage) {
      const end = Math.min(start + perMessage, logs.length);
      const slice = logs.slice(start, end);
      const title =
        start === 0
          ? "📜 История действий админов:"
          : `📜 История действий (записи ${start + 1}–${end}):`;
      const body = slice.map((e, j) => formatEntry(e, start + j)).join("\n\n");
      const isLast = end >= logs.length;
      await bot.sendMessage(chatId, `${title}\n\n${body}`, isLast ? { reply_markup: adminNavKeyboard() } : {});
    }
  } catch (e) {
    console.error("sendAdminHistory:", e?.message || e);
    await bot
      .sendMessage(chatId, "Не удалось показать историю. Полный журнал — в выгрузке «Таблица Excel (CSV)».", {
        reply_markup: adminNavKeyboard(),
      })
      .catch(() => {});
  }
}

function formatDate(date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function isBookingFinished(booking) {
  const start = parseDateTime(booking.datetime).getTime();
  const end = start + (booking.durationMinutes || 60) * 60000;
  return end <= Date.now();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isValidPhone(phone) {
  return /^\+?[0-9()\-\s]{10,20}$/.test(phone);
}

/** Бронь — объект; иначе строка (лог, админ). @ только у реального Telegram username. */
function formatUserTag(subject) {
  if (subject == null) return "-";
  if (typeof subject === "object" && subject !== null && "userId" in subject) {
    return formatBookingUserLabel(subject);
  }
  return formatPlainTelegramHandleOrName(String(subject));
}

function formatBookingUserLabel(b) {
  if (b.telegramUsername) return `@${String(b.telegramUsername).replace(/^@/, "")}`;
  if (b.userChatName && String(b.userChatName).trim()) return String(b.userChatName).trim();
  // Старые брони: в username могло быть имя без @ в Telegram — не превращаем в @username
  return legacyBookingDisplayName(b.username);
}

function legacyBookingDisplayName(raw) {
  if (!raw || raw === "unknown") return "-";
  return String(raw).trim();
}

/** Латинский ник Telegram 5–32 символа; иначе считаем именем/подписью без @ */
function looksLikeTelegramUsername(s) {
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(s);
}

function formatPlainTelegramHandleOrName(raw) {
  if (!raw || raw === "unknown") return "-";
  const s = String(raw).trim();
  if (s.startsWith("@")) return s;
  if (looksLikeTelegramUsername(s)) return `@${s}`;
  return s;
}

function bookingTextControls() {
  return {
    inline_keyboard: [
      [
        { text: "⬅ Назад", callback_data: "book_back" },
        { text: "🏠 В меню", callback_data: "menu" },
      ],
    ],
  };
}

function confirmInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Да, все верно", callback_data: "book_submit_yes" },
        { text: "❌ Нет, заполнить заново", callback_data: "book_submit_no" },
      ],
      [{ text: "⬅ Назад", callback_data: "book_back" }],
    ],
  };
}

function buildBookingPreview(data) {
  return [
    "Проверьте заявку:",
    `Помещение: ${formatRoomForDisplay(data.room)}`,
    `Время: ${formatRange(data.datetime, data.durationMinutes)}`,
    `ФИО: ${data.fullName}`,
    `Телефон: ${data.phone}`,
    `Цель: ${data.purpose}`,
    "",
    "Все введено правильно?",
  ].join("\n");
}

function addAdminActionLog(action, booking, adminUser) {
  const data = readBookings();
  if (!Array.isArray(data.actionLog)) data.actionLog = [];
  data.actionLog.unshift({
    at: new Date().toISOString(),
    action,
    bookingId: booking.id,
    room: booking.room,
    purpose: booking.purpose || "",
    datetime: booking.datetime,
    durationMinutes: booking.durationMinutes || 60,
    userId: booking.userId,
    userTag: formatUserTag(booking),
    adminId: adminUser.id,
    adminTag: formatUserTag(adminUser.username || adminUser.first_name || "admin"),
  });
  if (data.actionLog.length > 500) data.actionLog = data.actionLog.slice(0, 500);
  writeBookings(data);
}

/** Момент события (ISO UTC в логе) в «настенных часах» организации — как брони, не как часовой пояс сервера */
function formatLogDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const datePart = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return `${datePart} ${toHHMM(d)}`;
}

function getHelpText(userId) {
  if (isAdmin(userId)) {
    return `${HELP_TEXT_BASE}\n/admin — админ-панель (внутри: выгрузка броней в CSV)\n\nЖурнал действий админов: в интерфейсе только записи за последние ${ACTION_LOG_RETENTION_DAYS} сут.; раз в ${ACTION_LOG_PURGE_INTERVAL_DAYS} сут. — очистка журнала с напоминаниями и тремя CSV в личку (как кнопка «Таблица Excel»).`;
  }
  return HELP_TEXT_BASE;
}

function userNavKeyboard() {
  return {
    inline_keyboard: [[
      { text: "⬅ Назад", callback_data: "menu" },
      { text: "🏠 Главное меню", callback_data: "menu" },
    ]],
  };
}


function adminNavKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅ Назад в админ-панель", callback_data: "admin_menu" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }],
    ],
  };
}
