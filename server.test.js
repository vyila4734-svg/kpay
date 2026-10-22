const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  calculateQuote,
  createOrderStore,
  createServer,
  isValidSteamAccount,
  loadEnvFile,
  NsApiClient,
  readConfig,
  signRequest
} = require('./server');

test('loads private environment settings without overwriting existing environment variables', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpay-env-'));
  const filePath = path.join(directory, '.env');
  const env = { NS_LOGIN: 'environment-login' };
  fs.writeFileSync(filePath, '# local secrets\nNS_LOGIN=file-login\nNS_PASSWORD="private password"\n');

  try {
    loadEnvFile(filePath, env);
    assert.equal(env.NS_LOGIN, 'environment-login');
    assert.equal(env.NS_PASSWORD, 'private password');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a URL-safe Base64 API secret without padding', () => {
  const encodedSecret = Buffer.from('test secret').toString('base64url');
  const config = readConfig({
    NS_USER_ID: '1234',
    NS_LOGIN: 'api-login',
    NS_PASSWORD: 'api-password',
    NS_API_SECRET: encodedSecret
  });

  assert.equal(Buffer.from(config.secret, 'base64').toString(), 'test secret');
});

test('normalizes Base64 API secrets with redundant trailing padding', () => {
  const secret = Buffer.alloc(33, 1);
  const config = readConfig({
    NS_USER_ID: '1234',
    NS_LOGIN: 'api-login',
    NS_PASSWORD: 'api-password',
    NS_API_SECRET: `${secret.toString('base64')}=`
  });

  assert.deepEqual(Buffer.from(config.secret, 'base64'), secret);
});

test('calculates a quote in rubles with 5% service and bank fees', () => {
  const quote = calculateQuote(1000);

  assert.equal(quote.creditRub, 1000);
  assert.equal(quote.serviceFeeRub, 50);
  assert.equal(quote.paymentCostsRub, 50);
  assert.equal(quote.totalRub, 1100);
  assert.equal('rateRubPerUsd' in quote, false);
  assert.equal('amountUsd' in quote, false);
});

test('rejects amounts outside the supported range', () => {
  assert.throws(() => calculateQuote(99), /100 до 100 000/);
  assert.throws(() => calculateQuote(100_001), /100 до 100 000/);
});

test('accepts only Steam logins for the provider account field', () => {
  assert.equal(isValidSteamAccount('steam_login'), true);
  assert.equal(isValidSteamAccount('recipient.name+tag@example-domain.com'), false);
  assert.equal(isValidSteamAccount('player-name'), false);
  assert.equal(isValidSteamAccount(''), false);
});

test('persists orders and scopes the history to its browser session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpay-orders-'));
  const store = createOrderStore(path.join(directory, 'data', 'orders.json'));
  const order = { id: 'order-1', ownerId: 'session-1', title: 'Пополнение Steam' };

  try {
    await store.add(order);
    await store.add({ id: 'order-2', ownerId: 'session-2', title: 'Пополнение Steam' });

    assert.deepEqual(await store.list('session-1'), [
      { id: 'order-1', title: 'Пополнение Steam' }
    ]);
    assert.deepEqual(await store.list('session-2'), [
      { id: 'order-2', title: 'Пополнение Steam' }
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('API client bootstraps a token and signs Steam account check requests', async () => {
  const secret = Buffer.from('test secret').toString('base64');
  const received = [];
  const client = new NsApiClient({
    userId: '1234',
    login: 'api-login',
    password: 'api-password',
    secret,
    baseUrl: 'https://api.ns.gifts',
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      const body = options.body || Buffer.alloc(0);
      const timestamp = options.headers['X-Timestamp'];
      const token = options.headers['X-Token'] || null;
      assert.equal(options.headers['X-Signature'], signRequest({
        secret,
        method: options.method,
        requestPath: requestUrl.pathname,
        timestamp,
        token,
        body
      }));
      received.push({ path: requestUrl.pathname, body: body.length ? JSON.parse(body) : null });

      if (requestUrl.pathname === '/api/v2/get_token') {
        assert.equal(token, null);
        return Response.json({ token: 'session-token', expires_in: 7200 });
      }
      assert.equal(token, 'session-token');
      if (requestUrl.pathname === '/api/v2/steam/check_user') {
        return Response.json({ accountStatus: true });
      }
      assert.fail(`Unexpected API endpoint: ${requestUrl.pathname}`);
    }
  });

  const result = await client.request('POST', '/api/v2/steam/check_user', { steam_id: 'steam_user' });

  assert.equal(received.filter(request => request.path === '/api/v2/get_token').length, 1);
  assert.equal(result.accountStatus, true);
  assert.deepEqual(received.map(request => request.path).sort(), [
    '/api/v2/get_token',
    '/api/v2/steam/check_user'
  ]);
});

test('Steam order reports rejected NS API credentials without attempting to create an order', async () => {
  const apiCalls = [];
  const apiClient = new NsApiClient({
    userId: '1234',
    login: 'api-login',
    password: 'api-password',
    secret: Buffer.from('test secret').toString('base64'),
    fetchImpl: async url => {
      apiCalls.push(new URL(url).pathname);
      return Response.json({ detail: 'Invalid login details!' }, { status: 403 });
    }
  });
  const server = createServer({ apiClient, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/steam/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close'
      },
      body: JSON.stringify({ login: 'steam_user', amountRub: 1000 })
    });
    const result = await response.json();

    assert.equal(response.status, 502);
    assert.equal(result.code, 'INVALID_CREDENTIALS');
    assert.match(result.error, /NS API отклонил учётные данные/);
    assert.deepEqual(apiCalls, ['/api/v2/get_token']);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('local NS credential check authenticates without creating or storing an order', async () => {
  let receivedConfig;
  const server = createServer({
    apiClient: {},
    createApiClient(config) {
      receivedConfig = config;
      return { async getToken() { return 'temporary-token'; } };
    },
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ns/credentials-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        userId: '1234',
        login: 'api-login',
        password: 'api-password',
        secret: Buffer.from('test secret').toString('base64'),
        baseUrl: 'https://api.ns.gifts'
      })
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.connected, true);
    assert.equal(receivedConfig.userId, '1234');
    assert.equal(receivedConfig.login, 'api-login');
    assert.equal(receivedConfig.password, 'api-password');
    assert.equal(Buffer.from(receivedConfig.secret, 'base64').toString(), 'test secret');
    assert.equal(receivedConfig.baseUrl, 'https://api.ns.gifts');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('local NS credential check reports provider rejection without returning credentials', async () => {
  const server = createServer({
    apiClient: {},
    createApiClient: () => new NsApiClient({
      userId: '1234',
      login: 'api-login',
      password: 'api-password',
      secret: Buffer.from('test secret').toString('base64'),
      fetchImpl: async () => Response.json(
        { detail: 'Invalid login details!' },
        { status: 403 }
      )
    }),
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ns/credentials-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        userId: '1234',
        login: 'api-login',
        password: 'api-password',
        secret: Buffer.from('test secret').toString('base64'),
        baseUrl: 'https://api.ns.gifts'
      })
    });
    const result = await response.json();

    assert.equal(response.status, 401);
    assert.equal(result.code, 'INVALID_CREDENTIALS');
    assert.match(result.error, /отклонил учётные данные/);
    assert.equal(JSON.stringify(result).includes('api-password'), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('local NS credential check explains provider HTTP 403 as an access or allowlist issue', async () => {
  const server = createServer({
    apiClient: {},
    createApiClient: () => new NsApiClient({
      userId: '1234',
      login: 'api-login',
      password: 'api-password',
      secret: Buffer.from('test secret').toString('base64'),
      fetchImpl: async () => Response.json({ detail: 'Forbidden' }, { status: 403 })
    }),
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ns/credentials-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        userId: '1234',
        login: 'api-login',
        password: 'api-password',
        secret: Buffer.from('test secret').toString('base64'),
        baseUrl: 'https://api.ns.gifts'
      })
    });
    const result = await response.json();

    assert.equal(response.status, 403);
    assert.equal(result.code, 'ACCESS_DENIED');
    assert.match(result.error, /whitelist NS\.Gifts/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('local NS credential check rejects documentation placeholders as invalid form input', async () => {
  let apiClientCreated = false;
  const server = createServer({
    apiClient: {},
    createApiClient() {
      apiClientCreated = true;
      return { async getToken() { return 'unreachable'; } };
    },
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ns/credentials-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        userId: '1234',
        login: 'your_login',
        password: 'your_password',
        secret: 'PASTE-YOUR-BASE64-SECRET',
        baseUrl: 'https://api.ns.gifts'
      })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /настоящий Base64-секрет/);
    assert.equal(apiClientCreated, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Steam order endpoint creates an unpaid provider order in rubles without checking the account', async () => {
  const calls = [];
  const storedOrders = [];
  const apiClient = {
    async request(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/v2/exchange_rate') return { rates: { rub: 100 } };
      if (requestPath === '/api/v2/create_order') {
        return {
          custom_id: body.custom_id,
          total_to_pay: '1.0000',
          status: 'created'
        };
      }
      assert.fail(`Unexpected API endpoint: ${requestPath}`);
    }
  };
  const server = createServer({
    apiClient,
    orderStore: {
      async add(order) {
        storedOrders.push(order);
        return order;
      },
      async list() {
        return storedOrders;
      }
    },
    logger: { error() {} },
    now: () => Date.parse('2026-10-22T00:00:00.000Z')
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/steam/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ login: 'steam_user', amountRub: 1000 })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.paymentStarted, false);
    assert.equal(result.order.id, calls[1].body.custom_id);
    assert.equal(result.order.status, 'Ожидает оплаты');
    assert.equal(result.order.amount, 1000);
    assert.deepEqual(calls.map(call => call.requestPath), [
      '/api/v2/exchange_rate',
      '/api/v2/create_order'
    ]);
    assert.deepEqual(calls[1].body.fields, [
      { key: 'account', value: 'steam_user' },
      { key: 'amount', value: 10 }
    ]);
    assert.equal(calls[1].body.service_id, 1);
    assert.equal(storedOrders.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Steam order endpoint rejects amounts below 100 rubles before calling the provider', async () => {
  const apiClient = {
    async request() {
      assert.fail('Provider must not be called for invalid amounts');
    }
  };
  const server = createServer({ apiClient, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/steam/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ login: 'steam_user', amountRub: 99 })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /100/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Telegram Stars order creates the available provider package and stores it for the browser', async () => {
  const calls = [];
  const storedOrders = [];
  const apiClient = {
    async request(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/v2/create_order') {
        return {
          custom_id: body.custom_id,
          total_to_pay: '39.9738',
          status: 'created'
        };
      }
      assert.fail(`Unexpected API endpoint: ${requestPath}`);
    }
  };
  const server = createServer({
    apiClient,
    orderStore: {
      async add(order) {
        storedOrders.push(order);
        return order;
      }
    },
    logger: { error() {} },
    now: () => Date.parse('2026-10-22T00:00:00.000Z')
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stars/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: '@star_user', packageId: 2256 })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.paymentStarted, false);
    assert.equal(result.order.id, calls[0].body.custom_id);
    assert.equal(result.order.title, 'Telegram Stars');
    assert.equal(result.order.meta, 'Получатель: @star_user · 2 500 ⭐');
    assert.equal(result.order.amount, 6250);
    assert.deepEqual(calls, [{
      method: 'POST',
      requestPath: '/api/v2/create_order',
      body: {
        service_id: 2256,
        custom_id: result.order.id,
        fields: [{ key: 'account_number', value: 'star_user' }]
      }
    }]);
    assert.equal(storedOrders.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Telegram Stars order rejects invalid usernames before calling the provider', async () => {
  const apiClient = {
    async request() {
      assert.fail('Provider must not be called for invalid usernames');
    }
  };
  const server = createServer({ apiClient, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stars/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: '@no' })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /Telegram username/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Telegram Stars order rejects unavailable package IDs before calling the provider', async () => {
  const apiClient = {
    async request() {
      assert.fail('Provider must not be called for an unavailable package');
    }
  };
  const server = createServer({ apiClient, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stars/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: '@star_user', packageId: 9999 })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /доступный пакет Telegram Stars/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Telegram Premium order creates the selected provider plan and stores it for the browser', async () => {
  const calls = [];
  const storedOrders = [];
  const apiClient = {
    async request(method, requestPath, body) {
      calls.push({ method, requestPath, body });
      if (requestPath === '/api/v2/create_order') {
        return {
          custom_id: body.custom_id,
          total_to_pay: '17.1288',
          status: 'created'
        };
      }
      assert.fail(`Unexpected API endpoint: ${requestPath}`);
    }
  };
  const server = createServer({
    apiClient,
    orderStore: {
      async add(order) {
        storedOrders.push(order);
        return order;
      }
    },
    logger: { error() {} },
    now: () => Date.parse('2026-10-22T00:00:00.000Z')
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/premium/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: '@premium_user', packageId: 2247 })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.paymentStarted, false);
    assert.equal(result.order.id, calls[0].body.custom_id);
    assert.equal(result.order.title, 'Telegram Premium');
    assert.equal(result.order.meta, 'Получатель: @premium_user · 6 мес.');
    assert.equal(result.order.amount, 1599);
    assert.deepEqual(calls, [{
      method: 'POST',
      requestPath: '/api/v2/create_order',
      body: {
        service_id: 2247,
        custom_id: result.order.id,
        fields: [{ key: 'account_number', value: 'premium_user' }]
      }
    }]);
    assert.equal(storedOrders.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Telegram Premium order rejects unavailable plans before calling the provider', async () => {
  const apiClient = {
    async request() {
      assert.fail('Provider must not be called for an unavailable plan');
    }
  };
  const server = createServer({ apiClient, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/premium/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: '@premium_user', packageId: 9999 })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /доступный срок Telegram Premium/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('order history uses a private browser session cookie', async () => {
  const server = createServer({
    apiClient: {},
    orderStore: {
      async list(ownerId) {
        return ownerId === '11111111-1111-4111-8111-111111111111'
          ? [{ id: 'order-1', title: 'Пополнение Steam' }]
          : [];
      }
    },
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/orders`;
    const firstResponse = await fetch(baseUrl, { headers: { Connection: 'close' } });
    const firstCookie = firstResponse.headers.get('set-cookie');
    const firstOrders = await firstResponse.json();
    const sessionResponse = await fetch(baseUrl, {
      headers: {
        Cookie: 'kpay_session=11111111-1111-4111-8111-111111111111',
        Connection: 'close'
      }
    });
    const sessionOrders = await sessionResponse.json();

    assert.equal(firstOrders.orders.length, 0);
    assert.match(firstCookie, /HttpOnly/);
    assert.match(firstCookie, /SameSite=Lax/);
    assert.equal(sessionOrders.orders[0].id, 'order-1');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('static storefront explains Steam order creation and protects server files', async () => {
  const server = createServer({ apiClient: {}, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const pageResponse = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { Connection: 'close' }
    });
    const page = await pageResponse.text();
    const steamPageResponse = await fetch(`http://127.0.0.1:${address.port}/steam.html`, {
      headers: { Connection: 'close' }
    });
    const steamPage = await steamPageResponse.text();
    const starsPageResponse = await fetch(`http://127.0.0.1:${address.port}/stars.html`, {
      headers: { Connection: 'close' }
    });
    const starsPage = await starsPageResponse.text();
    const premiumPageResponse = await fetch(`http://127.0.0.1:${address.port}/premium.html`, {
      headers: { Connection: 'close' }
    });
    const premiumPage = await premiumPageResponse.text();
    const serverFileResponse = await fetch(`http://127.0.0.1:${address.port}/server.js`, {
      headers: { Connection: 'close' }
    });

    assert.equal(pageResponse.status, 200);
    assert.equal(steamPageResponse.status, 200);
    assert.equal(starsPageResponse.status, 200);
    assert.equal(premiumPageResponse.status, 200);
    assert.match(steamPage, /Пополнение <span lang="en">Steam<\/span>/);
    assert.match(steamPage, /id="steamForm"/);
    assert.match(steamPage, /Больше выгоды с <span lang="en">KPay<\/span>/);
    assert.match(steamPage, /Расчёт стоимости/);
    assert.match(steamPage, /Создать заказ на <span id="payAmount">1 000 ₽<\/span>/);
    assert.match(starsPage, /id="starAmounts"/);
    assert.match(starsPage, /data-order-type="stars"/);
    const starCounts = ['50', '100', '150', '250', '500', '1 000', '1 500', '2 500'];
    for (const packageId of [2249, 2250, 2251, 2252, 2253, 2254, 2255, 2256]) {
      assert.match(starsPage, new RegExp(`data-service-id="${packageId}"`));
    }
    for (const count of starCounts) {
      assert.match(starsPage, new RegExp(`<span class="amount-count">${count} ⭐</span>`));
      assert.match(page, new RegExp(`<span class="amount-count">${count} ⭐</span>`));
    }
    assert.doesNotMatch(starsPage, /class="amount-price"/);
    assert.doesNotMatch(page, /class="amount-price"/);
    assert.match(starsPage, /data-stars="2500"/);
    assert.match(starsPage, /<span class="amount-count">50 ⭐<\/span>/);
    assert.doesNotMatch(starsPage, /class="amount-unit"/);
    assert.match(starsPage, /id="starsNotice"/);
    assert.match(premiumPage, /id="periodOptions" role="radiogroup"/);
    assert.match(premiumPage, /type="radio" name="period" value="12"/);
    for (const packageId of [2246, 2247, 2248]) {
      assert.match(premiumPage, new RegExp(`data-service-id="${packageId}"`));
      assert.match(page, new RegExp(`data-service-id="${packageId}"`));
    }
    assert.match(premiumPage, /id="premiumSummaryRecipient"/);
    assert.match(premiumPage, /data-order-type="premium"/);
    assert.match(premiumPage, /id="premiumNotice"/);
    assert.match(starsPage, /id="starSummaryRecipient"/);
    assert.match(starsPage, /Создать заказ/);
    assert.match(page, /href="#steam">Пополнить/);
    assert.match(page, /id="steamForm"/);
    assert.match(page, /id="recipient"/);
    assert.match(page, /<span class="amount-count">50 ⭐<\/span>/);
    assert.doesNotMatch(page, /class="amount-unit"/);
    for (const packageId of [2249, 2250, 2251, 2252, 2253, 2254, 2255, 2256]) {
      assert.match(page, new RegExp(`data-service-id="${packageId}"`));
    }
    assert.match(page, /data-stars="2500"/);
    assert.match(page, /id="premiumUser"/);
    assert.match(page, /Услуги <span lang="en">Telegram<\/span>/);
    assert.match(page, /href="stars\.html">Купить звёзды/);
    assert.match(page, /href="premium\.html">Оформить/);
    assert.doesNotMatch(page, /href="steam\.html">Пополнение Steam/);
    assert.doesNotMatch(page, /id="(?:other|how)"|Всё цифровое — в одном месте|Как это работает/);
    assert.doesNotMatch(page, /#(?:other|how)/);
    assert.doesNotMatch(page, /steamLoginErrorTooltip/);
    assert.doesNotMatch(page, /NS API|USD|Курс NS API/i);
    assert.equal(serverFileResponse.status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
