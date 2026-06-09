require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { once } = require('events');

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const port = Number(process.env.PORT || 3000);
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const firebaseDatabaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://general-57884-default-rtdb.firebaseio.com';
const SESSION_PATH = 'telegramAuth/sessionString';

if (!apiId || !apiHash) {
  console.warn('⚠️ API_ID বা API_HASH সেট করা নেই।');
}

const privateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '')
  : undefined;

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: firebaseDatabaseURL,
});

const db = getDatabase();

let client = null;
let sessionString = new StringSession('');

function isFinitePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function readSavedSession() {
  const snapshot = await db.ref(SESSION_PATH).once('value');
  return snapshot.val() || '';
}

async function writeSavedSession(session) {
  await db.ref(SESSION_PATH).set(session || '');
}

async function clearSavedSession() {
  await db.ref(SESSION_PATH).remove();
}

async function buildClient(savedSession = '') {
  if (client) {
    try {
      await client.disconnect();
    } catch (_) {
      // ignore
    }
  }

  sessionString = new StringSession(savedSession || '');
  client = new TelegramClient(sessionString, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  return client;
}

async function ensureClient() {
  if (!client) {
    const savedSession = await readSavedSession();
    await buildClient(savedSession);
    return client;
  }

  try {
    await client.connect();
  } catch (_) {
    const savedSession = await readSavedSession();
    await buildClient(savedSession);
  }

  return client;
}

async function ensureAuthorized() {
  await ensureClient();
  try {
    const me = await client.getMe();
    return me || null;
  } catch (_) {
    return null;
  }
}

async function initTelegram() {
  try {
    const savedSession = await readSavedSession();

    await buildClient(savedSession);

    if (savedSession) {
      try {
        const me = await client.getMe();
        console.log(
          `✅ Telegram session restored as ${me.username || me.firstName || me.id}`
        );
      } catch (err) {
        console.log('⚠️ Saved session invalid. Clearing it and starting fresh.');
        console.error(err);
        await clearSavedSession();
        await buildClient('');
      }
    } else {
      console.log('⚠️ No saved Telegram session. Please log in from the frontend.');
    }
  } catch (error) {
    console.error('❌ Telegram init error:', error);
  }
}

async function persistCurrentSession() {
  const saved = client.session.save();
  await writeSavedSession(saved);
  return saved;
}

// Entity cache resolution (id parsing fixed for Telegram channel ids)
async function resolvePeer(chatId) {
  // Use BigInt for Telegram IDs to prevent safe integer limits
  const normalized = BigInt(chatId); 

  try {
    return await client.getInputEntity(normalized);
  } catch (firstErr) {
    console.log('⚠️ Entity cache miss. Refreshing dialogs...');
    await client.getDialogs({ limit: 200 });
    return await client.getInputEntity(normalized);
  }
}

function getDocumentMimeType(doc) {
  return (
    doc?.mimeType ||
    doc?.mime_type ||
    doc?.mime ||
    'video/mp4'
  );
}

function isVideoDocument(doc) {
  const mime = String(getDocumentMimeType(doc)).toLowerCase();
  if (mime.startsWith('video/')) return true;

  const attrs = Array.isArray(doc?.attributes) ? doc.attributes : [];
  return attrs.some((attr) => {
    const className = attr?.className || '';
    return className === 'DocumentAttributeVideo';
  });
}

function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  const range = rangeHeader.replace(/^bytes=/i, '').trim();
  const [startRaw, endRaw] = range.split('-');

  if (!startRaw && !endRaw) return null;
  if (!Number.isFinite(totalSize) || totalSize <= 0) return null;

  let start;
  let end;

  if (startRaw === '') {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : totalSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < 0 ||
    start > end ||
    start >= totalSize
  ) {
    return null;
  }

  end = Math.min(end, totalSize - 1);

  return { start, end };
}

function waitDrain(res) {
  return new Promise((resolve) => res.once('drain', resolve));
}

async function streamTelegramFile(file, res, { offset = 0, limit = undefined } = {}) {
  const request = {
    file,
    offset,
    requestSize: 1024 * 1024,
  };

  if (typeof limit === 'number') {
    request.limit = limit;
  }

  for await (const chunk of client.iterDownload(request)) {
    if (res.destroyed || res.writableEnded) {
      break;
    }

    if (!res.write(chunk)) {
      await waitDrain(res);
    }
  }
}

// --- API Routes --- //

// Home page (লগইন পেজ)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/login.html');
});

// Player page (স্মার্ট ভিডিও প্লেয়ার পেজ)
app.get('/player', (req, res) => {
  res.sendFile(__dirname + '/player.html');
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const me = await ensureAuthorized();
    res.json({
      ok: true,
      telegramConnected: !!client,
      loggedIn: !!me,
      userId: me?.id || null,
      username: me?.username || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// Send OTP
app.post('/api/send-code', async (req, res) => {
  try {
    await ensureClient();

    const phoneNumber = String(req.body.phoneNumber || '').trim();
    if (!phoneNumber) {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }

    const result = await client.sendCode(
      { apiId, apiHash },
      phoneNumber,
      false
    );

    res.json({
      success: true,
      phoneCodeHash: result.phoneCodeHash,
      isCodeViaApp: !!result.isCodeViaApp,
    });
  } catch (error) {
    console.error('SEND CODE ERROR:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login with OTP
app.post('/api/login', async (req, res) => {
  try {
    await ensureClient();

    const phoneNumber = String(req.body.phoneNumber || '').trim();
    const phoneCodeHash = String(req.body.phoneCodeHash || '').trim();
    const phoneCode = String(req.body.phoneCode || '').trim();

    if (!phoneNumber || !phoneCodeHash || !phoneCode) {
      return res.status(400).json({
        error: 'phoneNumber, phoneCodeHash, and phoneCode are required',
      });
    }

    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode,
      })
    );

    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      return res.status(400).json({
        success: false,
        signUpRequired: true,
        message: 'Telegram sign-up is required for this number.',
      });
    }

    const saved = await persistCurrentSession();

    res.json({
      success: true,
      message: 'লগইন সফল এবং সেশন সেভ হয়েছে!',
      sessionSaved: !!saved,
    });
  } catch (error) {
    console.error('LOGIN ERROR:', error);

    const msg = String(error?.errorMessage || error?.message || '');

    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      return res.status(400).json({
        success: false,
        requires2FA: true,
        message: '2FA পাসওয়ার্ড প্রয়োজন!',
      });
    }

    if (msg.includes('PHONE_CODE_INVALID')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP code',
      });
    }

    res.status(500).json({ error: error.message });
  }
});

// Submit 2FA password
app.post('/api/submit-password', async (req, res) => {
  try {
    await ensureClient();

    const password = String(req.body.password || '');
    if (!password) {
      return res.status(400).json({ error: 'password is required' });
    }

    await client.signInWithPassword(
      { apiId, apiHash },
      {
        password: async () => password,
        onError: async () => true,
      }
    );

    const saved = await persistCurrentSession();

    res.json({
      success: true,
      message: '2FA ভেরিফাই এবং লগইন সফল!',
      sessionSaved: !!saved,
    });
  } catch (error) {
    console.error('2FA ERROR:', error);

    const msg = String(error?.errorMessage || error?.message || '');
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('AUTH_USER_CANCEL')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid 2FA password',
      });
    }

    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/api/logout', async (req, res) => {
  try {
    await ensureClient();

    try {
      await client.invoke(new Api.auth.LogOut());
    } catch (logoutErr) {
      console.log('Logout invoke warning:', logoutErr.message);
    }

    await clearSavedSession();
    await buildClient('');

    res.json({
      success: true,
      message: 'লগআউট সফল এবং সেশন রিসেট হয়েছে।',
    });
  } catch (error) {
    console.error('LOGOUT ERROR:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login status
app.get('/api/status', async (req, res) => {
  try {
    const me = await ensureAuthorized();
    if (!me) {
      return res.json({ loggedIn: false });
    }

    res.json({
      loggedIn: true,
      name: me.firstName || me.username || 'Unknown',
      username: me.username || null,
      userId: me.id || null,
    });
  } catch (error) {
    res.json({ loggedIn: false });
  }
});

// Video streaming
app.get('/stream/:chatId/:messageId', async (req, res) => {
  try {
    const me = await ensureAuthorized();
    if (!me) {
      return res.status(401).send('NOT_AUTHORIZED');
    }

    const chatId = req.params.chatId;
    const messageId = Number(req.params.messageId);

    if (!Number.isFinite(messageId)) {
      return res.status(400).send('INVALID_MESSAGE_ID');
    }

    const peer = await resolvePeer(chatId);

    let messages;
    try {
      messages = await client.getMessages(peer, { ids: messageId });
    } catch (firstErr) {
      console.log('⚠️ First message lookup failed. Refreshing dialogs and retrying...');
      console.error(firstErr);
      await client.getDialogs({ limit: 200 });
      messages = await client.getMessages(peer, { ids: messageId });
    }

    const message = Array.isArray(messages) ? messages[0] : messages?.[0];

    if (!message) {
      return res.status(404).send('MESSAGE_NOT_FOUND');
    }

    if (!message.media) {
      return res.status(404).send('MEDIA_NOT_FOUND');
    }

    const doc = message.media.document;

    if (!doc) {
      return res.status(404).send('DOCUMENT_NOT_FOUND');
    }

    if (!isVideoDocument(doc)) {
      return res.status(415).send('NOT_A_VIDEO');
    }

    const mimeType = getDocumentMimeType(doc);
    const fileSize = Number(doc.size || 0);
    const rangeHeader = req.headers.range;
    const range = parseRangeHeader(rangeHeader, fileSize);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');

    if (rangeHeader && !range) {
      res.setHeader('Content-Range', `bytes */${isFinitePositiveNumber(fileSize) ? fileSize : '*'}`);
      return res.status(416).end();
    }

    const aborted = { value: false };
    req.on('close', () => {
      aborted.value = true;
    });

    if (range && isFinitePositiveNumber(fileSize)) {
      const chunkSize = range.end - range.start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
      res.setHeader('Content-Length', String(chunkSize));

      await streamTelegramFile(message.media, res, {
        offset: range.start,
        limit: chunkSize,
      });
    } else {
      if (isFinitePositiveNumber(fileSize)) {
        res.setHeader('Content-Length', String(fileSize));
      }

      await streamTelegramFile(message.media, res);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch (error) {
    console.error('========== STREAM ERROR ==========');
    console.error(error);

    if (!res.headersSent) {
      res.status(500).send('ভিডিও স্ট্রিম করতে সমস্যা হয়েছে');
    } else {
      try {
        res.end();
      } catch (_) {
        // ignore
      }
    }
  }
});

app.listen(port, async () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
  await initTelegram();
});
