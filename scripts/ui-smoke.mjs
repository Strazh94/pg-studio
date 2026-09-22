#!/usr/bin/env node
/**
 * UI-смоук PG Studio.
 *
 * Подключается к Chrome DevTools Protocol уже запущенного приложения
 * (electron . --remote-debugging-port=9222) и прогоняет реальный сценарий:
 * подключение к PostgreSQL → дерево схем → данные таблицы → SQL-запрос.
 *
 * Использование:
 *   electron . --remote-debugging-port=9222   # окно приложения
 *   node scripts/ui-smoke.mjs                 # в отдельном терминале
 *
 * Ожидаемые переменные окружения (как в интеграционном тесте):
 *   UI_PG_PASSWORD (по умолчанию postgres)
 */

const PORT = Number(process.env.UI_SMOKE_PORT ?? 9222);
const PASSWORD = process.env.UI_PG_PASSWORD ?? 'postgres';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // порт ещё не поднялся
    }
    await sleep(500);
  }
  throw new Error('Отладочный порт приложения не открылся');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('Не удалось подключиться к CDP'));
});

let nextId = 0;
const pending = new Map();
const problems = [];

ws.onmessage = (raw) => {
  const message = JSON.parse(raw.data);
  if (message.id) {
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    problems.push(`исключение: ${details?.exception?.description ?? JSON.stringify(details)}`);
  }
  if (message.method === 'Log.entryAdded') {
    const entry = message.params.entry;
    if (entry?.level === 'error' && !String(entry.text).includes('favicon')) {
      problems.push(`console: ${entry.text} (${entry.source}:${entry.line})`);
    }
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    nextId += 1;
    const requestId = nextId;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP-таймаут метода ${method}`));
    }, 20_000);
    pending.set(requestId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// window.confirm() блокирует рендерер — отвечаем на нативные диалоги через CDP.
const dialogs = [];
ws.addEventListener('message', (raw) => {
  const message = JSON.parse(raw.data);
  if (message.method === 'Page.javascriptDialogOpening') {
    dialogs.push(message.params.message);
    void send('Page.handleJavaScriptDialog', { accept: true });
  }
});

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(`Ошибка evaluate: ${JSON.stringify(response.result.exceptionDetails)}`);
  }
  return response.result?.result?.value;
}

async function waitFor(expression, what, timeout = 20000) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() - started > timeout) throw new Error(`Таймаут ожидания: ${what}`);
    await sleep(300);
  }
}

const results = [];
function check(name, value) {
  results.push(`${name}: ${JSON.stringify(value)}`);
  console.log(`  · ${name}: ${JSON.stringify(value)}`);
}

try {
  console.log('1. Отрисовка окна');
  await waitFor(`!!document.querySelector('.app')`, 'макет приложения', 25000);
  check('window.api', await evaluate(`typeof window.api`));

  const hasDialog = await evaluate(`!!document.querySelector('.dialog')`);
  if (hasDialog) {
    console.log('2. Диалог подключений');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.dialog button')]
        .find((b) => b.textContent.includes('Новое подключение'));
      if (button) { button.click(); return true; }
      return false;
    })()`);
    await waitFor(`!!document.querySelector('.dialog input[type="password"]')`, 'форма подключения');

    await evaluate(`(() => {
      const input = document.querySelector('.dialog input[type="password"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PASSWORD)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.dialog button')]
        .find((b) => b.textContent.includes('Сохранить и подключить'));
      button.click();
      return true;
    })()`);
    await waitFor(`!!document.querySelector('.tree-schema')`, 'дерево схем', 30000);
  } else {
    console.log('2. Уже подключено (авто-подключение к последнему)');
  }

  check('строка подключения', await evaluate(`document.querySelector('.conn-btn')?.textContent`));

  console.log('3. Таблица demo в сайдбаре');
  await waitFor(
    `[...document.querySelectorAll('.tree-table')].some((b) => b.textContent.includes('demo'))`,
    'таблица demo',
    20000,
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.tree-table')]
      .find((b) => b.textContent.includes('demo'));
    button.click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.data-grid tbody tr').length >= 3`, 'строки в сетке', 20000);
  check(
    'первая строка',
    await evaluate(`[...document.querySelectorAll('.data-grid tbody tr')[0].cells]
      .map((cell) => cell.textContent).join(' | ')`),
  );
  check(
    'шапка столбцов',
    await evaluate(`[...document.querySelectorAll('.data-grid thead th .col-name')]
      .map((el) => el.textContent).join(', ')`),
  );
  check('футер', await evaluate(`document.querySelector('.grid-footer')?.textContent.replace(/\\s+/g, ' ').trim()`));

  console.log('4. SQL-запрос');
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.topbar button')]
      .find((b) => b.textContent.includes('Запрос'));
    button.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.cm-content')`, 'CodeMirror', 15000);

  await evaluate(`(() => {
    const content = document.querySelector('.cm-content');
    content.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    selection.addRange(range);
    return document.execCommand('insertText', false,
      'SELECT id, name, qty FROM public.demo ORDER BY id');
  })()`);
  await waitFor(
    `document.querySelector('.cm-content')?.textContent.includes('SELECT id')`,
    'текст в редакторе',
    8000,
  );

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.editor-toolbar button')]
      .find((b) => b.textContent.includes('Выполнить'));
    button.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.result-grid tbody tr')`, 'результат SQL', 20000);
  check(
    'результат',
    await evaluate(`[...document.querySelectorAll('.result-grid tbody tr')[0].cells]
      .map((cell) => cell.textContent).join(' | ')`),
  );
  check(
    'всего результатов',
    await evaluate(`document.querySelectorAll('.result-grid tbody tr').length`),
  );

  console.log('5. Редактирование данных');
  await evaluate(`(() => {
    const tab = document.querySelector('.tab.table-tab');
    tab.click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.data-grid tbody tr').length >= 3`, 'возврат к сетке', 15000);

  // 5.1 правка ячейки двойным кликом
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.data-grid tbody tr')]
      .find((tr) => tr.textContent.includes('яблоко'));
    const cell = row.cells[2];
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.cell-edit input')`, 'редактор ячейки', 10000);
  await evaluate(`(() => {
    const input = document.querySelector('.cell-edit input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'яблоко-2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.cell-edit-btns button.ok').click();
    return true;
  })()`);
  await waitFor(
    `[...document.querySelectorAll('.data-grid tbody tr')].some((tr) => tr.textContent.includes('яблоко-2'))`,
    'обновлённое значение в сетке',
    20000,
  );
  check('правка ячейки', 'яблоко → яблоко-2 применена');

  // 5.2 добавление строки
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.grid-toolbar button')]
      .find((b) => b.textContent.includes('Строка'));
    button.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.insert-form')`, 'форма добавления', 10000);
  check(
    'поля по умолчанию',
    await evaluate(`(() => {
      const id = document.querySelector('#ins-id');
      return { idDisabled: id.disabled, placeholder: id.placeholder };
    })()`),
  );
  await evaluate(`(() => {
    const input = document.querySelector('#ins-name');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'слива');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.insert-actions button')]
      .find((b) => b.textContent.includes('Добавить')).click();
    return true;
  })()`);
  await waitFor(
    `[...document.querySelectorAll('.data-grid tbody tr')].some((tr) => tr.textContent.includes('слива'))`,
    'новая строка в сетке',
    20000,
  );
  check('строк после вставки', await evaluate(`document.querySelectorAll('.data-grid tbody tr').length`));

  // 5.3 удаление строки (window.confirm перехватывается через CDP)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.data-grid tbody tr')]
      .find((tr) => tr.textContent.includes('слива'));
    row.querySelector('.row-delete').click();
    return true;
  })()`);
  await waitFor(
    `![...document.querySelectorAll('.data-grid tbody tr')].some((tr) => tr.textContent.includes('слива'))`,
    'строка удалена',
    20000,
  );
  check('диалог подтверждения', dialogs);
  check(
    'строк после удаления',
    await evaluate(`document.querySelectorAll('.data-grid tbody tr').length`),
  );

  console.log('6. Проверка ошибок консоли');
  check('ошибки', problems);

  const failed = problems.length > 0;
  console.log(failed ? '\nСМОУК ПРОВАЛЕН' : '\nСМОУК ПРОШЁЛ');
  ws.close();
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error('\nСМОУК ПРОВАЛЕН:', error.message);
  if (problems.length > 0) console.error('Ошибки консоли:', problems);
  ws.close();
  process.exit(1);
}
