require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');

const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

const port = process.env.PORT || 3000;
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '')
    : undefined;

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey,
  }),
  databaseURL: "https://general-57884-default-rtdb.firebaseio.com"
});

const db = getDatabase();
let client;
let sessionString = new StringSession('');

// Startup Validation & Client Initialization
async function initTelegram() {
    try {
        const snapshot = await db.ref('telegramAuth/sessionString').once('value');
        const savedSession = snapshot.val() || '';

        sessionString = new StringSession(savedSession);
        
        client = new TelegramClient(sessionString, apiId, apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        
        if (savedSession) {
            try {
                await client.getMe(); 
                console.log("✅ Firebase থেকে সেশন লোড করে টেলিগ্রামে কানেক্ট হয়েছে!");
            } catch (err) {
                console.log("⚠️ সেশন এক্সপায়ার বা ইনভ্যালিড হয়ে গেছে। নতুন করে লগইন করুন।");
                sessionString = new StringSession('');
            }
        } else {
            console.log("⚠️ টেলিগ্রাম সেশন নেই। ব্রাউজার থেকে লগইন করুন...");
        }
    } catch (error) {
        console.error("❌ Telegram Client Init Error:", error.message);
    }
}

// ফোন নম্বর দিয়ে OTP পাঠানো
app.post('/api/send-code', async (req, res) => {
    try {
        if (!client.connected) await client.connect(); 
        const { phoneNumber } = req.body;
        const result = await client.sendCode({ apiId, apiHash }, phoneNumber);
        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// OTP দিয়ে লগইন করা
app.post('/api/login', async (req, res) => {
    try {
        if (!client.connected) await client.connect();
        const { phoneNumber, phoneCodeHash, phoneCode } = req.body;
        
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phoneNumber,
                phoneCodeHash: phoneCodeHash,
                phoneCode: phoneCode
            })
        );

        const newSession = client.session.save();
        await db.ref('telegramAuth/sessionString').set(newSession);

        res.json({ success: true, message: "লগইন সফল এবং সেশন সেভ হয়েছে!" });
    } catch (error) {
        if (error.message.includes("SESSION_PASSWORD_NEEDED")) {
            return res.json({ success: false, requires2FA: true, message: "2FA পাসওয়ার্ড প্রয়োজন!" });
        }
        res.status(500).json({ error: error.message });
    }
});

// 2FA পাসওয়ার্ড সাবমিট করা
app.post('/api/submit-password', async (req, res) => {
    try {
        if (!client.connected) await client.connect();
        const { password } = req.body;

        await client.invoke(
            new Api.auth.CheckPassword({
                password: password
            })
        );

        const newSession = client.session.save();
        await db.ref('telegramAuth/sessionString').set(newSession);

        res.json({ success: true, message: "2FA ভেরিফাই এবং লগইন সফল!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// লগআউট করা
app.post('/api/logout', async (req, res) => {
    try {
        if (!client.connected) await client.connect();
        await client.invoke(new Api.auth.LogOut());
        await db.ref('telegramAuth/sessionString').remove();

        // Proper Logout Reset
        await client.disconnect();
        sessionString = new StringSession('');
        client = new TelegramClient(sessionString, apiId, apiHash, { connectionRetries: 5 });
        await client.connect();

        res.json({ success: true, message: "লগআউট সফল এবং সেশন রিসেট হয়েছে।" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// লগইন স্ট্যাটাস চেক করা
app.get('/api/status', async (req, res) => {
    try {
        if (client && client.connected) {
            const me = await client.getMe();
            if (me) {
                return res.json({ loggedIn: true, name: me.firstName });
            }
        }
        res.json({ loggedIn: false });
    } catch (error) {
        res.json({ loggedIn: false });
    }
});

// ভিডিও স্ট্রিমিং এন্ডপয়েন্ট
app.get('/stream/:chatId/:messageId', async (req, res) => {
    try {
        if (!client.connected) await client.connect();

        const chatId = parseInt(req.params.chatId);
        const messageId = parseInt(req.params.messageId);

        const messages = await client.getMessages(chatId, { ids: messageId });
        const message = messages[0];

        if (!message || !message.media || !message.media.document) {
            return res.status(404).send("ভিডিও পাওয়া যায়নি");
        }

        const fileSize = Number(message.media.document.size);
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'video/mp4',
            });

            for await (const chunk of client.iterDownload({ 
                file: message.media,
                offset: start,
                limit: chunkSize,
                requestSize: 1024 * 1024 
            })) {
                res.write(chunk);
            }
            res.end();
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            });

            for await (const chunk of client.iterDownload({ file: message.media })) {
                res.write(chunk);
            }
            res.end();
        }
    } catch (error) {
        console.error("স্ট্রিমিং এরর:", error.message);
        if (!res.headersSent) {
            res.status(500).send("ভিডিও স্ট্রিম করতে সমস্যা হয়েছে");
        }
    }
});

app.listen(port, async () => {
    console.log(`🚀 Server is running on http://localhost:${port}`);
    await initTelegram();
});
