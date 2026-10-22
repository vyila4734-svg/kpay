const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const API_BASE_URL = 'https://api.ns.gifts';
const STATIC_FILES = new Set([
  '/index.html',
  '/ns-test.html',
  '/steam.html',
  '/stars.html',
  '/premium.html',
  '/buy.html',
  '/script.js',
  '/style.css'
]);
const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const MIN_ORDER_AMOUNT_RUB = 100;
const MAX_ORDER_AMOUNT_RUB = 100_000;
const TELEGRAM_STARS_PACKAGES = new Map([
  [2249, { quantity: 50, amountRub: 125 }],
  [2250, { quantity: 100, amountRub: 250 }],
  [2251, { quantity: 150, amountRub: 375 }],
  [2252, { quantity: 250, amountRub: 625 }],
  [2253, { quantity: 500, amountRub: 1250 }],
  [2254, { quantity: 1000, amountRub: 2500 }],
  [2255, { quantity: 1500, amountRub: 3750 }],
  [2256, { quantity: 2500, amountRub: 6250 }]
]);
const TELEGRAM_PREMIUM_PACKAGES = new Map([
  [2246, { duration: 3, amountRub: 849 }],
  [2247, { duration: 6, amountRub: 1599 }],
  [2248, { duration: 12, amountRub: 2999 }]
]);
const ORDER_SESSION_COOKIE = 'kpay_session';

class NsApiError extends Error {
  constructor(status, code = null) {
    super(`Provider API returned HTTP ${status}`);
    this.name = 'NsApiError';
    this.status = status;
    this.code = code;
  }
}

function signRequest({ secret, method, requestPath, query = '', timestamp, token, body }) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const parts = [method.toUpperCase(), requestPath, query, timestamp];
  if (token !== null && token !== undefined) parts.push(token);
  parts.push(bodyHash);

  return crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(parts.join('\n'))
    .digest('base64');
}

class NsApiClient {
  constructor({ userId, login, password, secret, baseUrl = API_BASE_URL, fetchImpl = fetch }) {
    this.userId = userId;
    this.loginName = login;
    this.password = password;
    this.secret = secret;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenRequest = null;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;

    this.tokenRequest = this.requestToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  async requestToken() {
    const requestPath = '/api/v2/get_token';
    const body = Buffer.from(JSON.stringify({
      login: this.loginName,
      password: this.password
    }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'X-User-Id': this.userId,
      'X-Timestamp': timestamp,
      'X-Signature': signRequest({
        secret: this.secret,
        method: 'POST',
        requestPath,
        timestamp,
        token: null,
        body
      })
    };
    const result = await this.send(`${this.baseUrl}${requestPath}`, {
      method: 'POST',
      headers,
      body
    });

    if (typeof result.token !== 'string' || !result.token) {
      throw new Error('Provider API did not return a session token');
    }

    this.token = result.token;
    this.tokenExpiresAt = Date.now() + (Number(result.expires_in) || 7200) * 1000;
    return this.token;
  }

  async request(method, requestPath, jsonBody) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getToken();
      const body = jsonBody === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(jsonBody));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = {
        'Content-Type': 'application/json',
        'X-User-Id': this.userId,
        'X-Timestamp': timestamp,
        'X-Token': token,
        'X-Signature': signRequest({
          secret: this.secret,
          method,
          requestPath,
          timestamp,
          token,
          body
        })
      };

      try {
        return await this.send(`${this.baseUrl}${requestPath}`, {
          method,
          headers,
          ...(jsonBody === undefined ? {} : { body })
        });
      } catch (error) {
        if (!(error instanceof NsApiError) || error.status !== 401 || attempt > 0) throw error;
        this.token = null;
        this.tokenExpiresAt = 0;
      }
    }

    throw new Error('Provider API authentication retry failed');
  }

  async send(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const providerMessage = [payload?.detail, payload?.message, payload?.error]
          .find(value => typeof value === 'string');
        const normalizedMessage = providerMessage?.trim().toLowerCase();
        const code = normalizedMessage === 'invalid login details!'
          ? 'INVALID_CREDENTIALS'
          : normalizedMessage === 'invalid signature'
            ? 'INVALID_SIGNATURE'
            : response.status === 403
              ? 'ACCESS_DENIED'
              : response.status === 401
                ? 'AUTHENTICATION_REJECTED'
                : null;
        throw new NsApiError(response.status, code);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function calculateQuote(amountRub) {
  if (!Number.isInteger(amountRub) || amountRub < 100 || amountRub > 100_000) {
    const error = new Error('Укажи сумму от 100 до 100 000 ₽.');
    error.statusCode = 400;
    throw error;
  }
  const creditRub = amountRub;
  const serviceFeeRub = creditRub * 0.05;
  const paymentCostsRub = creditRub * 0.05;

  return {
    creditRub,
    serviceFeeRub,
    paymentCostsRub,
    totalRub: creditRub + serviceFeeRub + paymentCostsRub
  };
}

function isValidSteamAccount(account) {
  return typeof account === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(account);
}

function normalizeTelegramUsername(username) {
  if (typeof username !== 'string') return null;
  const normalized = username.trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(normalized) ? normalized : null;
}

function loadEnvFile(filePath, env = process.env) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Не удалось прочитать файл настроек ${path.basename(filePath)}: ${error.message}`);
  }

  contents.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      throw new Error(`Некорректная строка ${index + 1} в файле ${path.basename(filePath)}.`);
    }

    const [, key] = match;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  });
}

function readConfig(env = process.env) {
  const required = ['NS_USER_ID', 'NS_LOGIN', 'NS_PASSWORD', 'NS_API_SECRET'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) {
    throw new Error(`Не заданы обязательные переменные окружения: ${missing.join(', ')}`);
  }
  if (!/^\d+$/.test(env.NS_USER_ID)) {
    throw new Error('NS_USER_ID должен быть числовым идентификатором.');
  }
  if (env.NS_API_SECRET.trim().toUpperCase() === 'PASTE-YOUR-BASE64-SECRET') {
    throw new Error('Замени пример API_SECRET на настоящий Base64-секрет из NS.Gifts.');
  }
  const base64Secret = env.NS_API_SECRET.replace(/-/g, '+').replace(/_/g, '/');
  const unpaddedSecret = base64Secret.replace(/=+$/, '');
  const decodedSecret = Buffer.from(base64Secret, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Secret) ||
      unpaddedSecret.length % 4 === 1 ||
      decodedSecret.length === 0 ||
      decodedSecret.toString('base64').replace(/=+$/, '') !== unpaddedSecret) {
    throw new Error('NS_API_SECRET должен быть корректным Base64-секретом.');
  }

  const baseUrl = env.NS_API_BASE_URL || API_BASE_URL;
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
    throw new Error('NS_API_BASE_URL должен использовать HTTPS.');
  }

  return {
    userId: env.NS_USER_ID,
    login: env.NS_LOGIN,
    password: env.NS_PASSWORD,
    secret: decodedSecret.toString('base64'),
    baseUrl
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1';
}

function createOrderStore(filePath) {
  let pendingWrite = Promise.resolve();

  function serialize(operation) {
    const result = pendingWrite.then(operation);
    pendingWrite = result.catch(() => {});
    return result;
  }

  async function readOrders() {
    try {
      const contents = await fs.promises.readFile(filePath, 'utf8');
      const orders = JSON.parse(contents);
      if (!Array.isArray(orders)) throw new Error('Order storage must contain an array');
      return orders;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  return {
    list: ownerId => serialize(async () =>
      (await readOrders())
        .filter(order => order.ownerId === ownerId)
        .map(({ ownerId: _ownerId, ...order }) => order)
    ),
    add: order => serialize(async () => {
      const orders = await readOrders();
      orders.push(order);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(orders, null, 2), 'utf8');
      return order;
    })
  };
}

function getOrderSession(request, response) {
  const cookie = (request.headers.cookie || '')
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${ORDER_SESSION_COOKIE}=`));
  const sessionId = cookie?.slice(ORDER_SESSION_COOKIE.length + 1);
  if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) return sessionId;

  const newSessionId = crypto.randomUUID();
  const secure = request.socket.encrypted ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${ORDER_SESSION_COOKIE}=${newSessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`
  );
  return newSessionId;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Размер запроса превышает лимит.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Некорректный JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function createServer({
  apiClient,
  createApiClient = config => new NsApiClient(config),
  root = ROOT,
  logger = console,
  now = Date.now,
  orderStore = createOrderStore(path.join(root, 'data', 'orders.json'))
}) {
  const requestCounts = new Map();

  function isRateLimited(request, response) {
    const clientIp = request.socket.remoteAddress || 'unknown';
    const currentTime = now();
    const recent = requestCounts.get(clientIp);
    if (recent && currentTime - recent.startedAt < RATE_LIMIT_WINDOW_MS &&
        recent.count >= RATE_LIMIT_MAX_REQUESTS) {
      sendJson(response, 429, { error: 'Слишком много запросов. Попробуй позже.' });
      return true;
    }
    if (!recent || currentTime - recent.startedAt >= RATE_LIMIT_WINDOW_MS) {
      requestCounts.set(clientIp, { startedAt: currentTime, count: 1 });
    } else {
      recent.count += 1;
    }
    if (requestCounts.size > 1000) {
      for (const [ip, entry] of requestCounts) {
        if (currentTime - entry.startedAt >= RATE_LIMIT_WINDOW_MS) requestCounts.delete(ip);
      }
    }
    return false;
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/ns/credentials-check') {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: 'Проверка доступна только на этом компьютере.' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Метод не поддерживается.' });
        return;
      }
      if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'Ожидается запрос в формате JSON.' });
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            ['userId', 'login', 'password', 'secret', 'baseUrl']
              .some(key => typeof body[key] !== 'string')) {
          sendJson(response, 400, { error: 'Заполни все пять полей строковыми значениями.' });
          return;
        }
        let config;
        try {
          config = readConfig({
            NS_USER_ID: body.userId,
            NS_LOGIN: body.login,
            NS_PASSWORD: body.password,
            NS_API_SECRET: body.secret,
            NS_API_BASE_URL: body.baseUrl
          });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        await createApiClient(config).getToken();
        sendJson(response, 200, { connected: true, message: 'Подключение к NS API успешно.' });
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        if (error.statusCode) {
          sendJson(response, error.statusCode, { error: error.message });
          return;
        }
        if (error instanceof NsApiError && error.code === 'INVALID_CREDENTIALS') {
          sendJson(response, 401, {
            code: error.code,
            error: 'NS API отклонил учётные данные. Проверь, что все четыре значения относятся к одному API-аккаунту.'
          });
          return;
        }
        if (error instanceof NsApiError && error.code === 'INVALID_SIGNATURE') {
          sendJson(response, 401, {
            code: error.code,
            error: 'NS API отклонил подпись. Проверь API-секрет и время на компьютере.'
          });
          return;
        }
        if (error instanceof NsApiError && error.code === 'ACCESS_DENIED') {
          sendJson(response, 403, {
            code: error.code,
            error: 'NS API вернул HTTP 403. По документации проверь IP сервера в whitelist NS.Gifts и права API-аккаунта.'
          });
          return;
        }
        if (error instanceof NsApiError && error.code === 'AUTHENTICATION_REJECTED') {
          sendJson(response, 401, {
            code: error.code,
            error: 'NS API вернул HTTP 401. Проверь подпись, точность часов компьютера и параметры запроса.'
          });
          return;
        }
        logger.error('NS API credential check failed:', error);
        sendJson(response, 502, {
          error: 'Не удалось проверить подключение к NS API. Проверь доступ к интернету и попробуй позже.'
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/api/orders') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Метод не поддерживается.' });
        return;
      }

      try {
        const ownerId = getOrderSession(request, response);
        sendJson(response, 200, { orders: await orderStore.list(ownerId) });
      } catch (error) {
        logger.error('Order list failed:', error);
        sendJson(response, 500, { error: 'Не удалось загрузить историю заказов.' });
      }
      return;
    }

    if (url.pathname === '/api/steam/orders') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Метод не поддерживается.' });
        return;
      }

      if (isRateLimited(request, response)) return;

      if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'Ожидается запрос в формате JSON.' });
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (!isValidSteamAccount(body.login)) {
          sendJson(response, 400, {
            error: 'Укажи логин Steam: 3–32 латинских символа, цифры или подчёркивание. Email не поддерживается.'
          });
          return;
        }

        const amountRub = Number(body.amountRub);
        if (!Number.isInteger(amountRub) ||
            amountRub < MIN_ORDER_AMOUNT_RUB ||
            amountRub > MAX_ORDER_AMOUNT_RUB) {
          sendJson(response, 400, {
            error: `Укажи сумму от ${MIN_ORDER_AMOUNT_RUB} до ${MAX_ORDER_AMOUNT_RUB.toLocaleString('ru-RU')} ₽.`
          });
          return;
        }

        const ownerId = getOrderSession(request, response);
        const exchange = await apiClient.request(
          'POST',
          '/api/v2/exchange_rate',
          { service_id: 1 }
        );
        const rubPerUsd = Number(exchange.rates?.rub);
        if (!Number.isFinite(rubPerUsd) || rubPerUsd <= 0) {
          throw new Error('Provider API returned an invalid RUB exchange rate');
        }

        const amountUsd = Math.round((amountRub / rubPerUsd) * 100) / 100;
        if (amountUsd < 0.13 || amountUsd > 500) {
          sendJson(response, 400, {
            error: 'Сумма в рублях после пересчёта должна соответствовать диапазону от 0,13 до 500 USD.'
          });
          return;
        }

        const customId = crypto.randomUUID();
        const providerOrder = await apiClient.request(
          'POST',
          '/api/v2/create_order',
          {
            service_id: 1,
            custom_id: customId,
            fields: [
              { key: 'account', value: body.login },
              { key: 'amount', value: amountUsd }
            ]
          }
        );
        if (providerOrder.custom_id !== customId ||
            typeof providerOrder.status !== 'string' ||
            providerOrder.status !== 'created') {
          throw new Error('Provider API returned an invalid order response');
        }

        let storedOrder;
        try {
          storedOrder = await orderStore.add({
            id: customId,
            ownerId,
            title: 'Пополнение Steam',
            meta: `Логин: ${body.login}`,
            amount: amountRub,
            amountUsd,
            providerTotal: providerOrder.total_to_pay ?? null,
            status: 'Ожидает оплаты',
            statusClass: 'pending',
            date: new Date(now()).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          });
        } catch (error) {
          logger.error(`Steam order ${customId} was created but could not be saved:`, error);
          sendJson(response, 500, {
            code: 'ORDER_HISTORY_SAVE_FAILED',
            error: `Заказ ${customId} создан у поставщика, но не сохранился в истории. Не создавай повторный заказ.`
          });
          return;
        }
        const { ownerId: _ownerId, ...order } = storedOrder;
        sendJson(response, 201, { order, paymentStarted: false });
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        if (error.statusCode) {
          sendJson(response, error.statusCode, { error: error.message });
          return;
        }
        logger.error('Steam order creation failed:', error);
        sendJson(response, 502, {
          code: error instanceof NsApiError ? error.code : undefined,
          error: error instanceof NsApiError && error.code === 'INVALID_CREDENTIALS'
            ? 'NS API отклонил учётные данные. Заказ не создан. Проверь, что NS_USER_ID, NS_LOGIN, NS_PASSWORD и NS_API_SECRET относятся к одному API-аккаунту. Если данные совпадают, обратись в поддержку NS.GIFTS для проверки доступа.'
            : error instanceof NsApiError && error.code === 'INVALID_SIGNATURE'
              ? 'NS API отклонил подпись запроса. Заказ не создан. Проверь NS_API_SECRET и время на сервере.'
              : error instanceof NsApiError
                ? 'Сервис заказов отклонил запрос. Проверь настройки API и доступ сервера.'
                : 'Не удалось создать заказ Steam. Попробуй позже.'
        });
      }
      return;
    }

    if (url.pathname === '/api/stars/orders') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Метод не поддерживается.' });
        return;
      }
      if (isRateLimited(request, response)) return;
      if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'Ожидается запрос в формате JSON.' });
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'Укажи Telegram username.' });
          return;
        }
        const username = normalizeTelegramUsername(body.username);
        if (!username) {
          sendJson(response, 400, {
            error: 'Укажи Telegram username: 5–32 латинских символа, цифры или подчёркивание.'
          });
          return;
        }
        const packageId = Number(body.packageId);
        const selectedPackage = TELEGRAM_STARS_PACKAGES.get(packageId);
        if (!Number.isInteger(packageId) || !selectedPackage) {
          sendJson(response, 400, { error: 'Выбери доступный пакет Telegram Stars.' });
          return;
        }

        const ownerId = getOrderSession(request, response);
        const customId = crypto.randomUUID();
        const providerOrder = await apiClient.request(
          'POST',
          '/api/v2/create_order',
          {
            service_id: packageId,
            custom_id: customId,
            fields: [{ key: 'account_number', value: username }]
          }
        );
        if (providerOrder.custom_id !== customId ||
            typeof providerOrder.status !== 'string' ||
            providerOrder.status !== 'created') {
          throw new Error('Provider API returned an invalid order response');
        }

        let storedOrder;
        try {
          storedOrder = await orderStore.add({
            id: customId,
            ownerId,
            title: 'Telegram Stars',
            meta: `Получатель: @${username} · ${selectedPackage.quantity.toLocaleString('ru-RU')} ⭐`,
            amount: selectedPackage.amountRub,
            providerTotal: providerOrder.total_to_pay ?? null,
            status: 'Ожидает оплаты',
            statusClass: 'pending',
            date: new Date(now()).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          });
        } catch (error) {
          logger.error(`Telegram Stars order ${customId} was created but could not be saved:`, error);
          sendJson(response, 500, {
            code: 'ORDER_HISTORY_SAVE_FAILED',
            error: `Заказ ${customId} создан у поставщика, но не сохранился в истории. Не создавай повторный заказ.`
          });
          return;
        }
        const { ownerId: _ownerId, ...order } = storedOrder;
        sendJson(response, 201, { order, paymentStarted: false });
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        if (error.statusCode) {
          sendJson(response, error.statusCode, { error: error.message });
          return;
        }
        logger.error('Telegram Stars order creation failed:', error);
        sendJson(response, 502, {
          code: error instanceof NsApiError ? error.code : undefined,
          error: error instanceof NsApiError && error.code === 'INVALID_CREDENTIALS'
            ? 'NS API отклонил учётные данные. Заказ не создан. Проверь настройки API-аккаунта.'
            : error instanceof NsApiError && error.code === 'INVALID_SIGNATURE'
              ? 'NS API отклонил подпись запроса. Заказ не создан. Проверь API-секрет и время на сервере.'
              : error instanceof NsApiError
                ? 'Сервис заказов отклонил запрос. Проверь настройки API и доступ сервера.'
                : 'Не удалось создать заказ Telegram Stars. Попробуй позже.'
        });
      }
      return;
    }

    if (url.pathname === '/api/premium/orders') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Метод не поддерживается.' });
        return;
      }
      if (isRateLimited(request, response)) return;
      if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
        sendJson(response, 415, { error: 'Ожидается запрос в формате JSON.' });
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'Укажи Telegram username и выбери срок подписки.' });
          return;
        }
        const username = normalizeTelegramUsername(body.username);
        if (!username) {
          sendJson(response, 400, {
            error: 'Укажи Telegram username: 5–32 латинских символа, цифры или подчёркивание.'
          });
          return;
        }
        const packageId = Number(body.packageId);
        const selectedPackage = TELEGRAM_PREMIUM_PACKAGES.get(packageId);
        if (!Number.isInteger(packageId) || !selectedPackage) {
          sendJson(response, 400, { error: 'Выбери доступный срок Telegram Premium.' });
          return;
        }

        const ownerId = getOrderSession(request, response);
        const customId = crypto.randomUUID();
        const providerOrder = await apiClient.request(
          'POST',
          '/api/v2/create_order',
          {
            service_id: packageId,
            custom_id: customId,
            fields: [{ key: 'account_number', value: username }]
          }
        );
        if (providerOrder.custom_id !== customId ||
            typeof providerOrder.status !== 'string' ||
            providerOrder.status !== 'created') {
          throw new Error('Provider API returned an invalid order response');
        }

        let storedOrder;
        try {
          storedOrder = await orderStore.add({
            id: customId,
            ownerId,
            title: 'Telegram Premium',
            meta: `Получатель: @${username} · ${selectedPackage.duration} мес.`,
            amount: selectedPackage.amountRub,
            providerTotal: providerOrder.total_to_pay ?? null,
            status: 'Ожидает оплаты',
            statusClass: 'pending',
            date: new Date(now()).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          });
        } catch (error) {
          logger.error(`Telegram Premium order ${customId} was created but could not be saved:`, error);
          sendJson(response, 500, {
            code: 'ORDER_HISTORY_SAVE_FAILED',
            error: `Заказ ${customId} создан у поставщика, но не сохранился в истории. Не создавай повторный заказ.`
          });
          return;
        }
        const { ownerId: _ownerId, ...order } = storedOrder;
        sendJson(response, 201, { order, paymentStarted: false });
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        if (error.statusCode) {
          sendJson(response, error.statusCode, { error: error.message });
          return;
        }
        logger.error('Telegram Premium order creation failed:', error);
        sendJson(response, 502, {
          code: error instanceof NsApiError ? error.code : undefined,
          error: error instanceof NsApiError && error.code === 'INVALID_CREDENTIALS'
            ? 'NS API отклонил учётные данные. Заказ не создан. Проверь настройки API-аккаунта.'
            : error instanceof NsApiError && error.code === 'INVALID_SIGNATURE'
              ? 'NS API отклонил подпись запроса. Заказ не создан. Проверь API-секрет и время на сервере.'
              : error instanceof NsApiError
                ? 'Сервис заказов отклонил запрос. Проверь настройки API и доступ сервера.'
                : 'Не удалось создать заказ Telegram Premium. Попробуй позже.'
        });
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 404, { error: 'Страница не найдена.' });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(response, 400, { error: 'Некорректный адрес страницы.' });
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    if (!STATIC_FILES.has(pathname) && !/^\/images\/[A-Za-z0-9_-]+\.png$/.test(pathname)) {
      sendJson(response, 404, { error: 'Страница не найдена.' });
      return;
    }
    const filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      sendJson(response, 403, { error: 'Доступ запрещён.' });
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        sendJson(response, error.code === 'ENOENT' ? 404 : 500, {
          error: error.code === 'ENOENT' ? 'Страница не найдена.' : 'Не удалось прочитать файл.'
        });
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.png': 'image/png'
      };
      response.writeHead(200, {
        'Content-Type': contentTypes[extension] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    });
  });
}

if (require.main === module) {
  loadEnvFile(path.join(ROOT, '.env'));
  const config = readConfig();
  const apiClient = new NsApiClient(config);
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer({ apiClient }).listen(port, host, () => {
    console.log(`KPay запущен: http://${host}:${port}`);
  });
}

module.exports = {
  calculateQuote,
  createOrderStore,
  createServer,
  loadEnvFile,
  isValidSteamAccount,
  NsApiClient,
  readConfig,
  signRequest
};
