# PG Studio

Настольный клиент и редактор для **PostgreSQL** на Electron + React. Работает на
macOS (сборка .dmg через CI), а также на Windows и Linux.

## Возможности

- **Менеджер подключений** — несколько подключений, проверка соединения,
  пароли шифруются через `safeStorage` (Keychain на macOS, DPAPI на Windows).
- **SQL-редактор** — вкладки, подсветка PostgreSQL, автодополнение схемы
  (таблицы и столбцы вашей базы), запуск по `Ctrl/⌘+Enter`, отмена запроса,
  результат в виде таблицы с ограничением в 2000 строк.
- **Просмотр данных таблиц** — дерево схем/таблиц в сайдбаре, постраничный
  просмотр, метаданные столбцов (тип, PK, `NOT NULL`, `DEFAULT`).
- **Редактирование данных** — двойной клик по ячейке (в т.ч. в NULL),
  добавление строк с учётом значений по умолчанию, удаление строк.
  UPDATE отправляет **только изменённые столбцы**, поиск строки — по PK
  (а если PK нет — по всем столбцам через `IS NOT DISTINCT FROM`).

## Требования

- Node.js 22+ и npm
- (опционально) Docker — для локального PostgreSQL и интеграционных тестов
- для сборки под macOS — GitHub Actions (или настоящий Mac)

## Запуск в разработке

```bash
npm install
npm run dev
```

`npm run dev` поднимает Vite (порт 5173), следит за компиляцией
`electron/` и открывает окно приложения с DevTools.

## Проверки

```bash
npm run typecheck   # TypeScript: рендерер + main-процесс
npm test            # юнит-тесты построения SQL и сериализации значений
```

Интеграционный тест против настоящего PostgreSQL (по желанию):

```bash
docker run -d --name pgstudio-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
PG_STUDIO_IT=1 PG_STUDIO_IT_PASSWORD=postgres npm test
```

Переменные окружения теста: `PG_STUDIO_IT_HOST`, `PG_STUDIO_IT_PORT`,
`PG_STUDIO_IT_USER`, `PG_STUDIO_IT_PASSWORD`, `PG_STUDIO_IT_DB`
(по умолчанию `localhost:5432/postgres`, пользователь `postgres`,
пароль `postgres`).

## UI-смоук (сценарий через реальное окно)

Проверяет весь стек глазами пользователя: подключение → дерево схем →
данные таблицы → SQL-запрос → правка ячейки → вставка и удаление строки:

```bash
# терминал 1: окно приложения с отладочным портом
npx electron . --remote-debugging-port=9222
# терминал 2: сценарий
node scripts/ui-smoke.mjs
```

Сценарий работает через Chrome DevTools Protocol (перехватывает
`window.confirm`, пишет в CodeMirror, читает DOM и ошибки консоли).
Порт переопределяется переменной `UI_SMOKE_PORT`, пароль БД — `UI_PG_PASSWORD`.

## Сборка под macOS

Сборка выполняется автоматически в GitHub Actions (`.github/workflows/build.yml`):

1. Залейте проект на GitHub и откройте вкладку **Actions**.
2. Запустите workflow **CI** (или просто сделайте push) — публикация релизов
   отключена (`--publish never`), всё сохраняется в артефакты запуска.
3. Готовые артефакты — внизу страницы запуска:
   - `PG-Studio-mac` — `PG Studio-0.1.0-arm64.dmg` (Apple Silicon) и
     `PG Studio-0.1.0.dmg` (Intel),
   - `PG-Studio-windows` — установщик `PG Studio Setup 0.1.0.exe`.

Либо через GitHub CLI, не открывая браузер:

```bash
gh run list --limit 5
gh run download <id> --name PG-Studio-mac
```

Локально на Mac:

```bash
npm install
npm run dist:mac   # release/PG Studio-*.dmg
```

Имя файла зависит от архитектуры: `PG Studio-0.1.0-arm64.dmg` (Apple Silicon)
и `PG Studio-0.1.0.dmg` (Intel). Соответствие можно увидеть и в логе запуска
Actions.

### Подпись приложения

Сборка в CI **не подписана** сертификатом Apple, поэтому при первом открытии
macOS покажет предупреждение Gatekeeper. Обход:

- правый клик (или `Control`+клик) по `.app` → **Открыть** → **Открыть**,
- либо `xattr -cr /Applications/PG\ Studio.app`.

Для распространения среди других людей нужен сертификат Apple Developer ID
и нотаризация (`notarytool`) — их добавление описано в документации
electron-builder.

## Структура проекта

```
electron/            main-процесс Electron
  main.ts            окно, жизненный цикл
  preload.ts         contextBridge — типизированный API для React
  ipc.ts             ipcMain-хендлеры (всё возвращает Result<T>)
  lib/connections.ts хранилище подключений + шифрование паролей
  lib/db.ts          пулы pg, метаданные, выборки, отмена запросов
  lib/sql.ts         чистые функции построения SQL (покрыты тестами)
  lib/*.test.ts      Vitest (unit + интеграция с PostgreSQL)
shared/types.ts      общие типы main ↔ renderer
src/                 React-приложение
  App.tsx            вкладки, подключения, дерево схем
  components/        диалог подключений, сайдбар, редактор, сетки
  lib/format.ts      отображение значений ячеек
scripts/ui-smoke.mjs UI-смоук окна через Chrome DevTools Protocol
.github/workflows/   CI: тесты + сборка .dmg/.exe
```

## Безопасность

- В рендере отключён доступ к Node: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`; между процессами — только
  мост `contextBridge` в `preload.ts`.
- SQL-запросы редактора выполняются как есть (это SQL-консоль — так и задумано),
  а операции с сеткой собираются **только** параметризованными запросами
  с экранированием идентификаторов.
- Пароли хранятся в `%APPDATA%/PG Studio/connections.json` и шифруются
  `safeStorage` (Keychain на macOS). Без доступа к ключевому хранилищу
  прочитать их нельзя.

## Известные ограничения

- Результат запроса ограничивается 2000 строк (чтобы «тяжёлая» выборка
  не забила память) — уточняйте выборку через `LIMIT`/фильтры.
- Нет визуального редактора схем, ER-диаграмм и миграций — это отдельные
  этапы развития.
