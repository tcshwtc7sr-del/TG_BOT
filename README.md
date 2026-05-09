# Room Booking Telegram Bot

Telegram-бот для бронирования помещений с inline-кнопками.

## Возможности

- Полностью кнопочный интерфейс (через `/start`)
- Создание заявки: помещение -> календарь (месяц/дни) -> слоты времени -> длительность -> цель
- Согласование заявок админом (approve/reject)
- Просмотр расписания, своих броней и заявок
- Отмена своей брони
- Напоминания перед встречей
- Отдельная админ-панель через `/admin`

## Установка

```bash
cd /Users/macbook/room-booking-bot
npm install
```

Если `npm` не установлен глобально, установите Node.js с npm.

## Настройка `.env`

Скопируйте шаблон и заполните значения:

```bash
cp .env.example .env
```

Пример:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_USER_IDS=1354700149
WORK_START_HOUR=9
WORK_END_HOUR=18
REMINDER_MINUTES_BEFORE=30
```

## Запуск

```bash
npm run bot:start
```

Если бот запущен успешно, увидите:

`Telegram booking bot is running...`
