require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const DB_FILE = 'approved_words.json'; 
const HISTORY_FILE = 'game_history.json';

let aiApprovedWords = {};
let globalGameHistory = []; 
const rooms = {};

// הגדרת סוכן המיילים
let transporter;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    console.log("📧 מערכת הדיוור האוטומטית מוכנה.");
}

// פונקציה לשליחת דוח מפורט למייל של סבא עופר
async function sendDetailedReport(historyRecord, allAnswers) {
    if (!transporter) return;
    try {
        let html = `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 20px; background-color: #f8f9fa;">
            <h2 style="color: #2c3e50;">📊 דוח משחק ארץ עיר - סבא עופר</h2>
            <p><strong>תאריך:</strong> ${historyRecord.date} | <strong>שעה:</strong> ${historyRecord.time}</p>
            <p><strong>האות:</strong> <span style="font-size: 2em; color: #f39c12;">${historyRecord.letter}</span></p>
        `;

        for (let playerName in allAnswers) {
            html += `
            <div style="background: white; border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; border-radius: 8px;">
                <h3 style="color: #3498db; margin-top: 0;">שחקן: ${playerName}</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: #eee;">
                            <th style="padding: 8px; border: 1px solid #ccc; text-align: right;">קטגוריה</th>
                            <th style="padding: 8px; border: 1px solid #ccc; text-align: right;">תשובה</th>
                            <th style="padding: 8px; border: 1px solid #ccc; text-align: center;">ניקוד</th>
                            <th style="padding: 8px; border: 1px solid #ccc; text-align: right;">נימוק השופט</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            const answers = allAnswers[playerName];
            for (let cat in answers) {
                const a = answers[cat];
                const color = a.points === 0 ? "#fdeaea" : (a.points < 10 ? "#fef9e7" : "#eafaf1");
                html += `
                <tr style="background-color: ${color};">
                    <td style="padding: 8px; border: 1px solid #ccc;">${cat}</td>
                    <td style="padding: 8px; border: 1px solid #ccc;"><strong>${a.val || "---"}</strong></td>
                    <td style="padding: 8px; border: 1px solid #ccc; text-align: center;">${a.points}</td>
                    <td style="padding: 8px; border: 1px solid #ccc; font-size: 0.85em;">${a.feedback || ""}</td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }
        html += `</div>`;

        await transporter.sendMail({
            from: `"ארץ עיר - בקרה" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `🎮 תוצאות משחק (אות: ${historyRecord.letter}) - ${historyRecord.date}`,
            html: html
        });
    } catch (e) { console.error("שגיאה במייל:", e.message); }
}

// --- מנגנון גילוי המודל של גוגל ---
let activeModelName = null;
async function initializeGemini() {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        const validModels = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
        const sorted = validModels.sort((a,b) => a.name.includes('flash') ? -1 : 1);
        for (let m of sorted) {
            const test = await fetch(`https://generativelanguage.googleapis.com/v1beta/${m.name}:generateContent?key=${apiKey}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({contents:[{parts:[{text:"test"}]}]})
            });
            if (test.ok) { activeModelName = m.name.replace('models/', ''); break; }
        }
        console.log(`✅ שופט AI פעיל: ${activeModelName}`);
    } catch (e) {}
}
initializeGemini();

app.post('/api/ask-judge-batch', async (req, res) => {
    try {
        const { letter, items } = req.body;
        let promptList = items.map(i => `קטגוריה: ${i.categoryLabel} (ID: ${i.catId}) | מילה: "${i.answer}"`).join('\n');
        const prompt = `אתה שופט במשחק 'ארץ עיר' באות '${letter}'. בדוק את המילים והחזר אך ורק JSON.
חוקים: נכון=10, שגיאת כתיב קלה=5, לא נכון/אות שגויה/לא קיים=0.
חובה לתת נימוק קצר בשדה 'reason'. השתמש ב-ID שקיבלת כמפתח.
{"results": {"catId": {"points": 10, "reason": "נימוק" }}} \n רשימה:\n${promptList}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModelName}:generateContent?key=${process.env.GEMINI_API_KEY.trim()}`;
        const response = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({contents:[{parts:[{text:prompt}]}]})});
        const data = await response.json();
        let jsonStr = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        res.json(JSON.parse(jsonStr));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        rooms[roomId] = { host: socket.id, letter: letters[Math.floor(Math.random() * 22)], players: [{ socketId: socket.id, name: data.hostName, isHost: true }], submissions: [] };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, letter: rooms[roomId].letter, players: rooms[roomId].players });
    });

    socket.on('submitScore', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        room.submissions.push({ name: data.playerName, score: data.totalScore, answers: data.answers });
        if (room.submissions.length >= room.players.length) {
            const leaderboard = [...room.submissions].sort((a,b) => b.score - a.score);
            const historyRecord = { date: new Date().toLocaleDateString('he-IL'), time: new Date().toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'}), letter: room.letter, players: leaderboard.map(p => ({ name: p.name, score: p.score })) };
            const allAnswers = {}; room.submissions.forEach(s => allAnswers[s.name] = s.answers);
            sendDetailedReport(historyRecord, allAnswers);
            io.to(data.roomId).emit('gameOver', { leaderboard, historyRecord });
            globalGameHistory.push(historyRecord);
        }
    });

    socket.on('logSinglePlayerHistory', (data) => {
        const allAnswers = {}; allAnswers[data.historyRecord.players[0].name] = data.fullAnswers;
        sendDetailedReport(data.historyRecord, allAnswers);
        globalGameHistory.push(data.historyRecord);
    });

    socket.on('getAdminData', () => {
        socket.emit('receiveAdminData', { history: globalGameHistory });
    });

    socket.on('restoreAdminData', (data) => {
        if (data.history) globalGameHistory = data.history;
    });

    socket.on('clearGameHistory', () => {
        globalGameHistory = [];
        socket.emit('receiveAdminData', { history: [] });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
