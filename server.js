/**
 * ========================================================================
 * LOCAL BRIDGE SERVER: TIKTOK LIVE TO ROBLOX BALAP LARI (RUNNER RACE)
 * Fitur:
 * 1. Menghubungkan langsung ke TikTok Live via tiktok-live-connector
 * 2. Menangkap Chat (!join / username roblox atau tiktok)
 * 3. Menangkap Gift (Rose, Donut, Lion, Universe -> Speed Boost)
 * 4. Menangkap Like (Tap boost sprint)
 * 5. Web Simulator & Control Panel di http://localhost:3000
 * 6. REST API untuk Roblox Studio long-polling (/api/actions)
 * ========================================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Konfigurasi Streamer
let tiktokUsername = process.env.TIKTOK_USERNAME || '';
let tiktokLiveConnection = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, CONNECTED, SIMULATOR
let lastError = null;
let currentRoomId = null;
let connectedAt = null;
let currentLobbyTimer = 30; // default 30 detik
let currentLaps = 1;        // default 1 lap

// Antrean aksi yang akan diambil oleh Roblox Studio
let actionQueue = [];
let recentEvents = []; // Untuk ditampilkan di Web Dashboard (maksimal 50)

// Helper tambah event
function pushAction(action) {
    action.id = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    action.timestamp = new Date().toISOString();
    actionQueue.push(action);
    
    recentEvents.unshift(action);
    if (recentEvents.length > 50) recentEvents.pop();
    return action;
}

// ========================================================================
// 1. PENGATURAN TRIGGER EFEK & PEMETAAN GIFT (PERSISTENT CONFIG)
// ========================================================================
const CONFIG_FILE = path.join(__dirname, 'effect_config.json');

const DEFAULT_EFFECT_CONFIG = {
    tier1: { speed: 18, duration: 3.5 },
    tier2: { speed: 38, duration: 5.0 },
    tier3: { speed: 75, duration: 7.0 },
    like:  { speed: 4,  duration: 1.2 },
    missile: { duration: 3.0 },
    nuke:    { duration: 4.0 },
    freeze:  { duration: 2.8 },
    dizzy:   { duration: 3.2 },
    lightning: { duration: 2.5 },
    banana:  { duration: 2.0 },
    shield:  { duration: 8.0 },
    triggers: {
        tier1_gifts: 'rose, mawar, tiktok, coffee, kopi, ice_cream, es_krim, bunga',
        missile: 'rocket, roket, bomb, bom, meteor, boxing_gloves, sarung_tinju, fireworks, kembang_api',
        nuke: 'donut, donat, doughnut, finger_heart, hati_jari, nuke, nuklir, dynamite, tnt',
        freeze: 'freeze, beku, ice, es, icecube, snowman, snowflake, salju',
        dizzy: 'dizzy, pusing, star, bintang, confuse, headache',
        lightning: 'lightning, petir, thunder, guntur, zap, magic_wand',
        banana: 'banana, pisang, shoe, sepatu, soap, sabun',
        shield: 'shield, perisai, heart, hati, mirror, cermin, umbrella, payung',
        tier2_gifts: 'cap, topi, paper_crane, burung_kertas, money_gun, pistol_uang, sunglasses, kacamata, perfume, parfum, crown, mahkota',
        tier3_gifts: 'lion, singa, universe, interstellar, whale, paus, train, kereta, falcon, elang'
    }
};

let effectConfig = { ...DEFAULT_EFFECT_CONFIG };

function parseKeywords(str) {
    if (!str) return [];
    return str.split(',').map(s => s.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
}

// Muat konfigurasi yang tersimpan jika ada
try {
    if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        effectConfig = {
            ...DEFAULT_EFFECT_CONFIG,
            ...parsed,
            triggers: {
                ...DEFAULT_EFFECT_CONFIG.triggers,
                ...(parsed.triggers || {})
            }
        };
    }
} catch (e) {
    console.error('Gagal membaca effect_config.json:', e);
}

function saveEffectConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(effectConfig, null, 2), 'utf8');
    } catch (e) {
        console.error('Gagal menyimpan effect_config.json:', e);
    }
}

function mapGiftToBoost(giftName, diamondCount) {
    const name = (giftName || '').toLowerCase().replace(/\s+/g, '_');
    const diamonds = diamondCount || 1;
    const trig = effectConfig.triggers || DEFAULT_EFFECT_CONFIG.triggers;

    // SABOTASE & ITEM COMEBACK
    if (parseKeywords(trig.missile).includes(name)) {
        return {
            tier: 2,
            tierKey: 'MISSILE',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.missile.duration || 3.0,
            vfx: 'HomingMissile',
            title: `🚀 HOMING MISSILE (TARGET LEADER #1 - ${effectConfig.missile.duration}s)`
        };
    }
    if (parseKeywords(trig.banana).includes(name)) {
        return {
            tier: 1,
            tierKey: 'BANANA',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.banana.duration || 2.0,
            vfx: 'BananaTrap',
            title: `🍌 JEBAKAN KULIT PISANG LICIN (${effectConfig.banana.duration}s)`
        };
    }
    if (parseKeywords(trig.shield).includes(name)) {
        return {
            tier: 2,
            tierKey: 'SHIELD',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.shield.duration || 8.0,
            vfx: 'BubbleShield',
            title: `🛡️ PERISAI BUBBLE KEBAL (${effectConfig.shield.duration}s)`
        };
    }
    if (parseKeywords(trig.freeze).includes(name)) {
        return {
            tier: 2,
            tierKey: 'FREEZE',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.freeze.duration || 2.8,
            vfx: 'FreezeMissile',
            title: `🧊 FREEZE MISSILE (BEKUKAN LAWAN DEPAN - ${effectConfig.freeze.duration}s)`
        };
    }
    if (parseKeywords(trig.dizzy).includes(name)) {
        return {
            tier: 2,
            tierKey: 'DIZZY',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.dizzy.duration || 3.2,
            vfx: 'DizzyOverheat',
            title: `😵 DIZZY OVERHEAT (PUSING OVERHEAT - ${effectConfig.dizzy.duration}s)`
        };
    }
    if (parseKeywords(trig.lightning).includes(name)) {
        return {
            tier: 2,
            tierKey: 'LIGHTNING',
            name: giftName,
            boostSpeed: 0,
            duration: effectConfig.lightning.duration || 2.5,
            vfx: 'ZeusLightning',
            title: `⚡ PETIR ZEUS ZAP (${effectConfig.lightning.duration}s)`
        };
    }
    // 5. MEGA NUKE: MELEDAKKAN SEMUA LAWAN SEKALIGUS!
    if (parseKeywords(trig.nuke).includes(name)) {
        return {
            tier: 3,
            tierKey: 'GLOBAL_NUKE',
            name: giftName,
            boostSpeed: 25,
            duration: effectConfig.nuke.duration || 4.0,
            vfx: 'GlobalNuke',
            title: `💥 MEGA NUKE (SEMUA LAWAN MELEDAK - ${effectConfig.nuke.duration}s)`
        };
    }

    // TIER 3: MEGA HYPER BOOST (100+ Diamonds atau Gift yang cocok)
    if (diamonds >= 100 || parseKeywords(trig.tier3_gifts).includes(name)) {
        return {
            tier: 3,
            name: giftName,
            boostSpeed: effectConfig.tier3.speed || 75,
            duration: effectConfig.tier3.duration || 7.0,
            vfx: 'HyperSonicRainbow',
            title: `⚡ HYPER OVERDRIVE BOOST! (+${effectConfig.tier3.speed} SPEED)`
        };
    }
    
    // TIER 2: SUPER TURBO BOOST (10 - 99 Diamonds atau Gift yang cocok)
    if (diamonds >= 10 || parseKeywords(trig.tier2_gifts).includes(name)) {
        return {
            tier: 2,
            name: giftName,
            boostSpeed: effectConfig.tier2.speed || 38,
            duration: effectConfig.tier2.duration || 5.0,
            vfx: 'FlameExhaustTurbo',
            title: `🔥 TURBO FLAME SPRINT! (+${effectConfig.tier2.speed} SPEED)`
        };
    }

    // TIER 1: SPEED BURST (1 - 9 Diamonds / Gift Ringan)
    return {
        tier: 1,
        name: giftName || 'Rose',
        boostSpeed: effectConfig.tier1.speed || 18,
        duration: effectConfig.tier1.duration || 3.5,
        vfx: 'WindStreakCyan',
        title: `💨 SPEED BURST! (+${effectConfig.tier1.speed} SPEED)`
    };
}

// ========================================================================
// 2. KONEKSI KE TIKTOK LIVE
// ========================================================================
function connectToTikTok(username) {
    if (!username || username === 'ganti_dengan_username_tiktokmu' || username.trim() === '') {
        console.log('⚠️ Username TikTok belum diisi. Mode SIMULATOR aktif di http://localhost:' + PORT);
        connectionStatus = 'SIMULATOR';
        currentRoomId = null;
        return;
    }

    tiktokUsername = username.trim().replace(/^@/, '');
    connectionStatus = 'CONNECTING';
    lastError = null;
    currentRoomId = null;
    console.log(`📡 Mencoba menghubungkan ke TikTok Live: @${tiktokUsername}...`);

    try {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
            tiktokLiveConnection = null;
        }

        tiktokLiveConnection = new WebcastPushConnection(tiktokUsername, {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            enableWebsocketUpgrade: true,
            requestPollingIntervalMs: 1000
        });

        tiktokLiveConnection.connect().then(state => {
            connectionStatus = 'CONNECTED';
            currentRoomId = state.roomId;
            connectedAt = new Date().toISOString();
            lastError = null;
            console.log(`✅ BERHASIL TERHUBUNG ke TikTok Live @${tiktokUsername} (Room ID: ${state.roomId})`);
        }).catch(err => {
            connectionStatus = 'SIMULATOR';
            lastError = err.message || String(err);
            currentRoomId = null;
            console.log(`⚠️ Gagal terhubung ke TikTok Live (@${tiktokUsername}): ${lastError}`);
            console.log(`💡 Mode SIMULATOR aktif. Anda bisa test dari Web Dashboard!`);
        });

        // Event: CHAT (Pendaftaran Lomba Balap Lari)
        tiktokLiveConnection.on('chat', data => {
            const comment = (data.comment || '').trim();
            const lower = comment.toLowerCase();
            
            // Format pendaftaran utama:
            // Cukup ketik @username (username TikTok atau Roblox) di kolom komentar Live!
            // Fallback tetap didukung: !join, join, !ikut, ikut, !daftar, daftar, !gas, gas, 1
            let robloxUser = null;
            let isJoinCommand = false;

            const atMatch = comment.match(/@([a-zA-Z0-9_.]{2,30})/);
            if (atMatch) {
                isJoinCommand = true;
                const extracted = atMatch[1].replace(/[^a-zA-Z0-9_]/g, '');
                robloxUser = extracted || data.uniqueId;
            } else if (comment === '@') {
                isJoinCommand = true;
                robloxUser = data.uniqueId;
            }

            if (!isJoinCommand) {
                const prefixes = ['!join', 'join', '!ikut', 'ikut', '!daftar', 'daftar', '!gas', 'gas'];
                for (const p of prefixes) {
                    if (lower.startsWith(p)) {
                        isJoinCommand = true;
                        const parts = comment.split(/\s+/);
                        if (parts.length > 1) {
                            robloxUser = parts[1].replace(/[^a-zA-Z0-9_]/g, '');
                        }
                        break;
                    }
                }
            }
            if (!isJoinCommand && (lower === '1' || lower === '!1' || lower === 'balap')) {
                isJoinCommand = true;
            }

            if (isJoinCommand) {
                console.log(`🏃 [JOIN RACE] @${data.uniqueId} mendaftar! (Username: @${robloxUser || data.uniqueId})`);
                pushAction({
                    type: 'join',
                    tiktokUser: data.uniqueId,
                    nickname: data.nickname || data.uniqueId,
                    robloxUser: robloxUser || data.uniqueId,
                    profilePicUrl: data.profilePictureUrl || ''
                });
            }
        });

        // Event: GIFT (Speed Boost Lari Cepat)
        tiktokLiveConnection.on('gift', data => {
            // Hindari duplikasi saat streak berlangsung, tapi tangkap repeatEnd atau single gift
            if (data.giftType === 1 && !data.repeatEnd) {
                return;
            }

            // Otomatis daftarkan penonton ke lomba jika belum join saat nyawer gift
            pushAction({
                type: 'join',
                tiktokUser: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                robloxUser: data.uniqueId,
                profilePicUrl: data.profilePictureUrl || ''
            });

            const boostInfo = mapGiftToBoost(data.giftName, data.diamondCount);
            console.log(`🎁 [GIFT BOOST] @${data.uniqueId} kirim ${data.giftName} -> Tier ${boostInfo.tier} (+${boostInfo.boostSpeed} Speed)`);

            pushAction({
                type: 'gift',
                tiktokUser: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                giftName: data.giftName,
                diamondCount: data.diamondCount || 1,
                repeatCount: data.repeatCount || 1,
                tier: boostInfo.tier,
                tierKey: boostInfo.tierKey,
                boostSpeed: boostInfo.boostSpeed,
                duration: boostInfo.duration,
                vfx: boostInfo.vfx,
                title: boostInfo.title
            });
        });

        // Event: LIKE (Tap Boost Lari)
        tiktokLiveConnection.on('like', data => {
            const tapCount = Math.min(data.likeCount || 1, 15);
            pushAction({
                type: 'like',
                tiktokUser: data.uniqueId,
                nickname: data.nickname || data.uniqueId,
                likeCount: tapCount,
                boostSpeed: effectConfig.like.speed || 4,       // Mini boost tiap like streak disesuaikan streamer
                duration: effectConfig.like.duration || 1.2
            });
        });

        // Event: SHARE
        tiktokLiveConnection.on('share', data => {
            console.log(`📢 [SHARE] @${data.uniqueId} membagikan live stream!`);
            pushAction({
                type: 'share',
                tiktokUser: data.uniqueId,
                boostSpeed: 25,
                duration: 3.0
            });
        });

        tiktokLiveConnection.on('disconnected', () => {
            console.log('🔌 Koneksi TikTok Live terputus.');
            connectionStatus = 'DISCONNECTED';
        });

    } catch (err) {
        connectionStatus = 'SIMULATOR';
        lastError = err.message;
        console.error('Error in connectToTikTok:', err);
    }
}

// Inisialisasi awal
connectToTikTok(tiktokUsername);

// ========================================================================
// 3. REST API UNTUK ROBLOX STUDIO (LONG-POLLING)
// ========================================================================

// Endpoint utama yang dipanggil oleh Roblox Studio Script tiap 0.3 - 0.5 detik
app.get('/api/actions', (req, res) => {
    const eventsToSend = [...actionQueue];
    actionQueue = []; // Kosongkan antrean setelah diambil Roblox
    res.json({
        success: true,
        count: eventsToSend.length,
        actions: eventsToSend
    });
});

// Endpoint status
app.get('/api/status', (req, res) => {
    res.json({
        tiktokUsername,
        connectionStatus,
        roomId: currentRoomId,
        connectedAt,
        lastError,
        queueLength: actionQueue.length,
        currentLobbyTimer,
        currentLaps,
        effectConfig,
        recentEvents
    });
});

// Endpoint pengaturan trigger efek & boost
app.get('/api/config/effects', (req, res) => {
    res.json({ success: true, config: effectConfig });
});

app.post('/api/config/effects', (req, res) => {
    const newCfg = req.body;
    if (newCfg && typeof newCfg === 'object') {
        effectConfig = {
            ...effectConfig,
            ...newCfg,
            triggers: {
                ...effectConfig.triggers,
                ...(newCfg.triggers || {})
            }
        };
        saveEffectConfig();
        console.log('⚙️ Pengaturan trigger efek berhasil diperbarui oleh streamer!');
        return res.json({ success: true, config: effectConfig, message: 'Pengaturan efek berhasil disimpan.' });
    }
    res.status(400).json({ error: 'Format konfigurasi tidak valid' });
});

app.post('/api/config/effects/reset', (req, res) => {
    effectConfig = { ...DEFAULT_EFFECT_CONFIG };
    saveEffectConfig();
    console.log('🔄 Pengaturan trigger efek di-reset ke nilai default.');
    res.json({ success: true, config: effectConfig, message: 'Pengaturan efek di-reset ke default.' });
});

// Endpoint putuskan koneksi TikTok
app.post('/api/disconnect', (req, res) => {
    if (tiktokLiveConnection) {
        try { tiktokLiveConnection.disconnect(); } catch (e) {}
        tiktokLiveConnection = null;
    }
    connectionStatus = 'DISCONNECTED';
    currentRoomId = null;
    lastError = null;
    console.log(`🔌 Koneksi TikTok Live @${tiktokUsername} diputuskan manual oleh streamer.`);
    res.json({ success: true, message: 'Koneksi TikTok berhasil diputus.' });
});

// Endpoint untuk memuat seluruh script ke Roblox Studio via MCP
app.get('/api/all-files', (req, res) => {
    const dir = path.join(__dirname, '..', 'TikTokLiveRace');
    const files = [
        'GameConfig.luau',
        'SFXManager.luau',
        'VFXManager.luau',
        'AnimationManager.luau',
        'TrackBuilder.luau',
        'RunnerSpawner.luau',
        'LeaderboardUI.luau',
        'BridgeService.luau',
        'RaceManager.luau',
        'MainServer.luau',
        'RaceCameraClient.luau'
    ];
    const result = {};
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) {
            result[file.replace('.luau', '')] = fs.readFileSync(filePath, 'utf8');
        }
    }
    res.json({ success: true, files: result });
});

// Endpoint ganti username TikTok
app.post('/api/set-username', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ error: 'Username wajib diisi' });
    }
    connectToTikTok(username.trim().replace(/^@/, ''));
    res.json({ success: true, message: `Mencoba menghubungkan ke @${tiktokUsername}` });
});

// ========================================================================
// 4. ENDPOINT TESTING / SIMULATOR (UNTUK STREAMER & PENGUJIAN)
// ========================================================================

// Test Join
app.get('/test/join', (req, res) => {
    const user = req.query.user || 'Runner_' + Math.floor(100 + Math.random() * 900);
    const roblox = req.query.roblox || user;
    const action = pushAction({
        type: 'join',
        tiktokUser: user,
        nickname: user,
        robloxUser: roblox,
        profilePicUrl: ''
    });
    res.json({ success: true, message: `Spawned runner ${user}`, action });
});

// Test Gift
app.get('/test/gift', (req, res) => {
    const user = req.query.user || 'Runner_1';
    const giftName = req.query.gift || 'Rose';
    const diamonds = parseInt(req.query.diamonds || '1', 10);
    const boostInfo = mapGiftToBoost(giftName, diamonds);

    const action = pushAction({
        type: 'gift',
        tiktokUser: user,
        giftName: giftName,
        diamondCount: diamonds,
        repeatCount: 1,
        tier: boostInfo.tier,
        tierKey: boostInfo.tierKey,
        boostSpeed: boostInfo.boostSpeed,
        duration: boostInfo.duration,
        vfx: boostInfo.vfx,
        title: boostInfo.title
    });
    res.json({ success: true, message: `Gift ${giftName} for ${user}`, action });
});

// Test Like
app.get('/test/like', (req, res) => {
    const user = req.query.user || 'Runner_1';
    const count = parseInt(req.query.count || '5', 10);
    const action = pushAction({
        type: 'like',
        tiktokUser: user,
        likeCount: count,
        boostSpeed: effectConfig.like.speed || 4,
        duration: effectConfig.like.duration || 1.2
    });
    res.json({ success: true, message: `Like from ${user}`, action });
});

// Test Quick Fill (Bisa isi Baris 1 [10 orang], Baris 2 [20 orang], Baris 3 [25+ orang])
app.get('/test/spawn-batch', (req, res) => {
    const total = parseInt(req.query.count || '25', 10);
    const pool = [
        'BudiSpeed', 'SitiTurbo', 'RizkyRunner', 'AsepFlash', 'DewiKilat',
        'FajarSprint', 'PutriDash', 'GitaFlash', 'AgusRocket', 'MegaHyper',
        'DoniDash', 'RinaSwift', 'BayuBlaze', 'EkaTurbo', 'HadiSprint',
        'IndahFlash', 'JokoSpeed', 'KikiRunner', 'LinaSonic', 'MayaRocket',
        'NandaHyper', 'OkiDash', 'PrasSwift', 'RianBlaze', 'SuryaTurbo'
    ];
    const toSpawn = pool.slice(0, total);
    toSpawn.forEach(name => {
        pushAction({
            type: 'join',
            tiktokUser: name,
            nickname: name,
            robloxUser: name,
            profilePicUrl: ''
        });
    });
    res.json({ success: true, message: `Spawned ${toSpawn.length} bot runners across rows!` });
});

// Trigger Start / Reset Race secara manual dari Web
app.get('/test/race-control', (req, res) => {
    const command = req.query.cmd || 'start'; // 'start', 'reset'
    const action = pushAction({
        type: 'command',
        command: command
    });
    res.json({ success: true, message: `Command ${command} sent to Roblox!`, action });
});

// Endpoint ubah setting Timer dan Lap secara dinamis
app.get('/test/set-settings', (req, res) => {
    const timer = req.query.timer ? parseInt(req.query.timer, 10) : null;
    const laps = req.query.laps ? parseInt(req.query.laps, 10) : null;
    let actions = [];

    if (timer && timer >= 5) {
        currentLobbyTimer = timer;
        const act = pushAction({
            type: 'command',
            command: 'set_lobby_timer',
            seconds: timer
        });
        actions.push(act);
    }
    if (laps && laps >= 1) {
        currentLaps = laps;
        const act = pushAction({
            type: 'command',
            command: 'set_laps',
            laps: laps
        });
        actions.push(act);
    }
    res.json({
        success: true,
        currentLobbyTimer,
        currentLaps,
        actions
    });
});

// ========================================================================
// 5. WEB DASHBOARD & SIMULATOR UI (INTERAKTIF & MODERN)
// ========================================================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ TikTok Live Roblox Balap Lari - Control Center</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0b0f19;
            --card-bg: #151c2c;
            --accent-cyan: #00f2fe;
            --accent-magenta: #fe0979;
            --accent-gold: #ffb703;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --border: #243048;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Poppins', sans-serif;
            background: radial-gradient(circle at top, #182238 0%, #0b0f19 100%);
            color: var(--text-main);
            min-height: 100vh;
            padding: 24px;
        }
        .container { max-width: 1100px; margin: 0 auto; }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 20px;
            border-bottom: 2px solid var(--border);
            margin-bottom: 24px;
        }
        .logo-area h1 {
            font-size: 26px;
            font-weight: 800;
            background: linear-gradient(90deg, var(--accent-cyan), var(--accent-magenta));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .logo-area p { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
        .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #1e293b;
            padding: 8px 16px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            border: 1px solid var(--border);
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 10px #10b981;
        }
        .status-dot.connecting { background: #f59e0b; box-shadow: 0 0 10px #f59e0b; }
        .status-dot.disconnected { background: #ef4444; box-shadow: 0 0 10px #ef4444; }

        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        }
        .card h2 {
            font-size: 16px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--accent-cyan);
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 12px;
        }
        input {
            flex: 1;
            background: #0d1320;
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 14px;
            color: #fff;
            font-family: inherit;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        input:focus { border-color: var(--accent-cyan); }
        button {
            cursor: pointer;
            border: none;
            border-radius: 10px;
            padding: 12px 20px;
            font-weight: 700;
            font-family: inherit;
            font-size: 13px;
            transition: all 0.2s;
        }
        .btn-primary {
            background: linear-gradient(135deg, #00f2fe, #4facfe);
            color: #0b0f19;
        }
        .btn-primary:hover { opacity: 0.9; transform: translateY(-2px); }

        .btn-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            margin-top: 10px;
        }
        .btn-action {
            background: #1e293b;
            color: #fff;
            border: 1px solid var(--border);
            padding: 12px;
            text-align: left;
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .btn-action:hover {
            background: #27354f;
            border-color: var(--accent-cyan);
            transform: translateY(-2px);
        }
        .btn-action span.title { font-weight: 700; font-size: 13px; }
        .btn-action span.sub { font-size: 11px; color: var(--text-muted); }

        .btn-tier1 { border-left: 4px solid #38bdf8; }
        .btn-tier2 { border-left: 4px solid #f97316; }
        .btn-tier3 { border-left: 4px solid #a855f7; }
        .btn-spawn { border-left: 4px solid #22c55e; }

        .feed-container {
            max-height: 480px;
            overflow-y: auto;
            background: #0d1320;
            border-radius: 12px;
            padding: 12px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
        }
        .feed-item {
            padding: 8px 10px;
            border-radius: 8px;
            margin-bottom: 8px;
            background: #161e30;
            border-left: 3px solid #64748b;
            display: flex;
            justify-content: space-between;
            align-items: center;
            animation: fadeIn 0.3s ease;
        }
        .feed-item.join { border-color: #22c55e; }
        .feed-item.gift { border-color: #f59e0b; }
        .feed-item.like { border-color: #ec4899; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

        .guide-box {
            background: rgba(0, 242, 254, 0.05);
            border: 1px dashed var(--accent-cyan);
            border-radius: 12px;
            padding: 16px;
            margin-top: 20px;
            font-size: 13px;
            line-height: 1.6;
        }
        .guide-box strong { color: var(--accent-cyan); }

        .status-alert-box {
            margin-top: 14px;
            padding: 12px 14px;
            border-radius: 10px;
            font-size: 13px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            transition: all 0.3s ease;
        }
        .status-alert-box.connected {
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid #10b981;
            color: #34d399;
        }
        .status-alert-box.connecting {
            background: rgba(245, 158, 11, 0.15);
            border: 1px solid #f59e0b;
            color: #fbbf24;
        }
        .status-alert-box.simulator {
            background: rgba(56, 189, 248, 0.08);
            border: 1px solid #0284c7;
            color: #7dd3fc;
        }
        .status-alert-box.error {
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid #ef4444;
            color: #fca5a5;
        }
        .btn-disconnect {
            background: #ef4444;
            color: #fff;
            padding: 6px 14px;
            font-size: 12px;
            border-radius: 8px;
            margin-top: 6px;
            width: fit-content;
            font-weight: 700;
        }
        .btn-disconnect:hover {
            background: #dc2626;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo-area">
                <h1>⚡ TIKTOK BALAP LARI CONTROL CENTER</h1>
                <p>Jembatan Interaktif TikTok Live ke Roblox Studio Engine</p>
            </div>
            <div class="status-badge" id="statusBadge">
                <div class="status-dot" id="statusDot"></div>
                <span id="statusText">CONNECTING...</span>
            </div>
        </header>

        <div class="grid">
            <!-- KOLOM KIRI: KONTROL STREAMER & SIMULATOR -->
            <div>
                <!-- KARTU 1: KONEKSI TIKTOK -->
                <div class="card" style="margin-bottom: 20px;">
                    <h2>📡 Koneksi TikTok Live</h2>
                    <div class="input-group">
                        <input type="text" id="usernameInput" placeholder="Contoh: username_tiktok (tanpa @)" value="${tiktokUsername}">
                        <button class="btn-primary" id="btnConnect" onclick="updateUsername()">Hubungkan</button>
                    </div>

                    <!-- DYNAMIC CONNECTION ALERT BOX -->
                    <div id="connectionAlert" class="status-alert-box simulator">
                        <div><strong>🎮 Mode Simulator Aktif</strong></div>
                        <div style="font-size: 12px; opacity: 0.85;">Belum terhubung ke live. Anda bisa mencoba game dengan tombol-tombol simulator di bawah ini.</div>
                    </div>

                    <div style="margin-top: 14px; font-size: 12px; color: var(--text-muted); line-height: 1.5;">
                        <span style="color: var(--accent-cyan); font-weight: 600;">💡 Cara Menghubungkan ke Live:</span>
                        <ol style="margin-left: 18px; margin-top: 4px;">
                            <li>Buka <strong>TikTok Live Studio</strong> / HP & tekan <strong>"Go Live"</strong>.</li>
                            <li>Ketik username TikTok Anda di atas & klik <strong>"Hubungkan"</strong>.</li>
                            <li>Tunggu indikator berubah menjadi <strong>HIJAU (ONLINE)</strong>.</li>
                            <li>Di Roblox Studio, klik <strong>Play</strong> — game langsung membaca chat & gift penonton!</li>
                        </ol>
                    </div>
                </div>

                <!-- KARTU 2: PENGATURAN BALAPAN (TIMER & LAPS) -->
                <div class="card" style="margin-bottom: 20px;">
                    <h2>⚙️ Pengaturan Balapan (Timer & Lap)</h2>
                    
                    <!-- SETTING 1: TIMER PENDAFTARAN -->
                    <div style="margin-bottom: 18px; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span style="font-weight: 700; font-size: 13px; color: var(--accent-cyan); display: flex; align-items: center; gap: 6px;">
                                ⏱️ Timer Pendaftaran (Lobby):
                            </span>
                            <span id="activeTimerBadge" style="background: rgba(0,242,254,0.15); color: var(--accent-cyan); border: 1px solid var(--accent-cyan); padding: 3px 12px; border-radius: 999px; font-weight: 800; font-size: 12px;">
                                30 Detik
                            </span>
                        </div>
                        <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setTimerPreset(15)">15s</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setTimerPreset(30)">30s</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setTimerPreset(45)">45s</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setTimerPreset(60)">60s</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setTimerPreset(90)">90s</button>
                        </div>
                        <div class="input-group" style="margin-bottom: 0;">
                            <input type="number" id="customTimerInput" placeholder="Ketik detik custom (misal: 25)" min="5" max="300" style="padding: 9px 12px; font-size: 13px;">
                            <button class="btn-primary" style="padding: 9px 16px; font-size: 12px;" onclick="applyCustomTimer()">Set Timer</button>
                        </div>
                    </div>

                    <!-- SETTING 2: JUMLAH PUTARAN (LAPS) -->
                    <div style="margin-bottom: 14px; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span style="font-weight: 700; font-size: 13px; color: #34d399; display: flex; align-items: center; gap: 6px;">
                                🏁 Jumlah Putaran Sirkuit (Total Laps):
                            </span>
                            <span id="activeLapsBadge" style="background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid #10b981; padding: 3px 12px; border-radius: 999px; font-weight: 800; font-size: 12px;">
                                1 Lap
                            </span>
                        </div>
                        <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setLapsPreset(1)">1 Lap</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setLapsPreset(2)">2 Laps</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setLapsPreset(3)">3 Laps</button>
                            <button class="btn-action" style="flex: 1; text-align: center; padding: 7px; font-size: 12px; justify-content: center;" onclick="setLapsPreset(5)">5 Laps</button>
                        </div>
                        <div class="input-group" style="margin-bottom: 0;">
                            <input type="number" id="customLapsInput" placeholder="Ketik jumlah lap custom (misal: 3)" min="1" max="20" style="padding: 9px 12px; font-size: 13px;">
                            <button class="btn-primary" style="padding: 9px 16px; font-size: 12px; background: linear-gradient(135deg, #10b981, #059669);" onclick="applyCustomLaps()">Set Lap</button>
                        </div>
                    </div>

                    <!-- KONTROL RONDE SHORTCUT -->
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button class="btn-action" style="flex: 1; border-left: 4px solid #eab308;" onclick="simRaceControl('start')">
                            <span class="title">🏁 Mulai Balapan Sekarang</span>
                            <span class="sub">Lewati sisa timer countdown</span>
                        </button>
                        <button class="btn-action" style="flex: 1; border-left: 4px solid #ef4444;" onclick="simRaceControl('reset')">
                            <span class="title">🔄 Reset Ronde Baru</span>
                            <span class="sub">Kembalikan ke garis start</span>
                        </button>
                    </div>
                </div>

                <!-- KARTU 2.5: PENGATURAN TRIGGER EFEK & KECEPATAN HADIAH -->
                <div class="card" style="margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <h2>🎛️ Pengaturan Trigger Efek & Kecepatan</h2>
                        <span id="fxSaveStatus" style="font-size: 11px; padding: 3px 10px; border-radius: 999px; background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid #10b981; display: none;">✅ Tersimpan</span>
                    </div>
                    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
                        Sesuaikan kecepatan lari dan durasi efek hadiah penonton saat Live sesuai selera Anda:
                    </p>

                    <!-- TAB SECTION 1: KECEPATAN GIFT & LIKE -->
                    <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 12px;">
                        <span style="font-weight: 700; font-size: 13px; color: var(--accent-cyan); display: block; margin-bottom: 10px;">
                            ⚡ Kecepatan Lari (Speed Boost Penonton)
                        </span>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                            <!-- TIER 1 -->
                            <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                                <label style="font-size: 11px; font-weight: 700; color: #38bdf8;">🌹 Tier 1 (Rose/Gift 1-9 Koin)</label>
                                <div style="display: flex; gap: 6px; margin-top: 4px;">
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">+Speed</small><input type="number" id="cfg_t1_speed" value="18" min="5" max="200" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">Durasi (s)</small><input type="number" id="cfg_t1_dur" value="3.5" step="0.5" min="1" max="30" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                </div>
                            </div>
                            <!-- TIER 2 -->
                            <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                                <label style="font-size: 11px; font-weight: 700; color: #f59e0b;">🧢 Tier 2 (Topi/Gift 10-99 Koin)</label>
                                <div style="display: flex; gap: 6px; margin-top: 4px;">
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">+Speed</small><input type="number" id="cfg_t2_speed" value="38" min="5" max="300" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">Durasi (s)</small><input type="number" id="cfg_t2_dur" value="5.0" step="0.5" min="1" max="30" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                </div>
                            </div>
                            <!-- TIER 3 -->
                            <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                                <label style="font-size: 11px; font-weight: 700; color: #eab308;">🦁 Tier 3 (Singa/Sultan 100+ Koin)</label>
                                <div style="display: flex; gap: 6px; margin-top: 4px;">
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">+Speed</small><input type="number" id="cfg_t3_speed" value="75" min="10" max="500" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">Durasi (s)</small><input type="number" id="cfg_t3_dur" value="7.0" step="0.5" min="1" max="30" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                </div>
                            </div>
                            <!-- LIKE TAP -->
                            <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);">
                                <label style="font-size: 11px; font-weight: 700; color: #ec4899;">❤️ Tap Layar (Likes)</label>
                                <div style="display: flex; gap: 6px; margin-top: 4px;">
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">+Speed</small><input type="number" id="cfg_like_speed" value="4" min="1" max="50" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                    <div style="flex: 1;"><small style="font-size: 10px; color: var(--text-muted);">Durasi (s)</small><input type="number" id="cfg_like_dur" value="1.2" step="0.2" min="0.5" max="10" style="padding: 5px; font-size: 12px; width: 100%;"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- TAB SECTION 2: SABOTASE & ITEM -->
                    <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 14px;">
                        <span style="font-weight: 700; font-size: 13px; color: #f43f5e; display: block; margin-bottom: 10px;">
                            💣 Sabotase & Efek Item Penonton
                        </span>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">🚀 Homing Missile Stun (s):</small>
                                <input type="number" id="cfg_missile_dur" value="3.0" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">💥 Mega Nuke Stun Massal (s):</small>
                                <input type="number" id="cfg_nuke_dur" value="4.0" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">🧊 Freeze Missile Beku (s):</small>
                                <input type="number" id="cfg_freeze_dur" value="2.8" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">😵 Dizzy Overheat Pusing (s):</small>
                                <input type="number" id="cfg_dizzy_dur" value="3.2" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">⚡ Petir Zeus Kejut (s):</small>
                                <input type="number" id="cfg_lightning_dur" value="2.5" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <small style="font-size: 11px; color: #cbd5e1;">🍌 Kulit Pisang Licin (s):</small>
                                <input type="number" id="cfg_banana_dur" value="2.0" step="0.5" min="0.5" max="15" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div style="grid-column: span 2;">
                                <small style="font-size: 11px; color: #cbd5e1;">🛡️ Bubble Shield Kebal (s):</small>
                                <input type="number" id="cfg_shield_dur" value="8.0" step="0.5" min="1.0" max="30" style="padding: 6px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                        </div>
                    </div>

                    <!-- TAB SECTION 3: PEMETAAN NAMA GIFT TRIGGER TIKTOK -->
                    <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 14px;">
                        <span style="font-weight: 700; font-size: 13px; color: #a855f7; display: block; margin-bottom: 4px;">
                            🎁 Pemetaan Nama Gift Saweran TikTok untuk Setiap Efek
                        </span>
                        <p style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
                            Ketik nama gift penonton (pisahkan dengan koma <code>,</code> jika lebih dari satu):
                        </p>

                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #38bdf8;">🌹 Gift Tier 1 Speed Burst (Gift Ringan / Mawar):</label>
                                <input type="text" id="trig_tier1" placeholder="rose, mawar, tiktok, coffee, kopi, ice_cream, es_krim, bunga" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #dc2626;">💥 Gift Mega Nuke (Semua Lawan Meledak):</label>
                                <input type="text" id="trig_nuke" placeholder="donut, donat, doughnut, finger_heart, hati_jari, nuke, nuklir" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #ef4444;">🚀 Gift Homing Missile (Target #1):</label>
                                <input type="text" id="trig_missile" placeholder="rocket, roket, bomb, bom, meteor, boxing_gloves, sarung_tinju, fireworks, kembang_api" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #38bdf8;">🧊 Gift Freeze Missile (Bekukan Lawan Depan):</label>
                                <input type="text" id="trig_freeze" placeholder="freeze, beku, ice, es, icecube, snowman, snowflake, salju" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #f43f5e;">😵 Gift Dizzy Overheat (Pusing Merah):</label>
                                <input type="text" id="trig_dizzy" placeholder="dizzy, pusing, star, bintang, confuse, headache" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #eab308;">⚡ Gift Petir Zeus (Sengatan Kejut):</label>
                                <input type="text" id="trig_lightning" placeholder="lightning, petir, thunder, guntur, zap, magic_wand" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #facc15;">🍌 Gift Kulit Pisang (Jebakan Licin):</label>
                                <input type="text" id="trig_banana" placeholder="banana, pisang, shoe, sepatu, soap, sabun" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #00f2fe;">🛡️ Gift Bubble Shield (Perisai Kebal):</label>
                                <input type="text" id="trig_shield" placeholder="shield, perisai, heart, hati, mirror, cermin, umbrella, payung" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #f59e0b;">🧢 Gift Tier 2 Turbo Sprint:</label>
                                <input type="text" id="trig_tier2" placeholder="cap, topi, paper_crane, burung_kertas, money_gun, pistol_uang, sunglasses, kacamata" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div>
                                <label style="font-size: 11px; font-weight: 700; color: #eab308;">🦁 Gift Tier 3 Hyper Overdrive (Sultan):</label>
                                <input type="text" id="trig_tier3" placeholder="lion, singa, universe, interstellar, whale, paus, train, kereta, falcon, elang" style="padding: 6px 10px; font-size: 12px; width: 100%; margin-top: 2px;">
                            </div>
                            <div style="font-size: 11px; color: var(--text-muted); line-height: 1.4; margin-top: 4px;">
                                💡 <em>Gift saweran TikTok lainnya (1–9 koin seperti Mawar / Rose) otomatis memicu <strong>Tier 1 Speed Burst</strong>.</em>
                            </div>
                        </div>
                    </div>

                    <!-- TOMBOL AKSI SIMPAN -->
                    <div style="display: flex; gap: 8px;">
                        <button class="btn-primary" style="flex: 2; padding: 10px; font-size: 13px; font-weight: 700; background: linear-gradient(135deg, #10b981, #059669);" onclick="saveCustomEffects()">
                            💾 Simpan Pengaturan Efek
                        </button>
                        <button class="btn-action" style="flex: 1; padding: 10px; font-size: 12px; text-align: center; justify-content: center;" onclick="resetCustomEffects()">
                            🔄 Reset Default
                        </button>
                    </div>
                </div>

                <!-- KARTU 3: QUICK TEST SIMULATOR -->
                <div class="card">
                    <h2>🎮 Simulator & Pengujian Cepat</h2>
                    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
                        Klik tombol di bawah ini untuk menguji reaksi avatar di Roblox tanpa perlu live TikTok:
                    </p>

                    <div class="btn-grid">
                        <button class="btn-action btn-spawn" onclick="simBatchJoin(25)">
                            <span class="title">👥 Spawn 25 Pelari (Multi-Row)</span>
                            <span class="sub">Isi Baris 1, Baris 2, Baris 3</span>
                        </button>
                        <button class="btn-action btn-spawn" onclick="simJoin()">
                            <span class="title">🏃 +1 Pelari (Spotlight Cam)</span>
                            <span class="sub">Sorot avatar & masuk antrean</span>
                        </button>
                        <button class="btn-action btn-tier1" onclick="simGift('Mawar', 1)">
                            <span class="title">🌹 Sawer Mawar / Rose (+18 Speed)</span>
                            <span class="sub">Tier 1: Speed Burst Lari Cepat</span>
                        </button>
                        <button class="btn-action btn-tier2" onclick="simGift('Topi', 99)">
                            <span class="title">🧢 Sawer Topi / Cap (+38 Speed)</span>
                            <span class="sub">Tier 2: 3D Twin Jetpack</span>
                        </button>
                        <button class="btn-action btn-tier3" onclick="simGift('Singa', 500)">
                            <span class="title">🦁 Sawer Singa / Lion (+75 Speed)</span>
                            <span class="sub">Tier 3: Hyper Overdrive Sultan</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #dc2626;" onclick="simGift('Donut', 30)">
                            <span class="title">💥 Sawer Donut / Donat (Mega Nuke)</span>
                            <span class="sub">Ledakkan SEMUA lawan di lintasan!</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #ec4899;" onclick="simLike()">
                            <span class="title">❤️ Tap Layar (Like)</span>
                            <span class="sub">Mini speed boost (+4)</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #ef4444;" onclick="simGift('rocket', 10)">
                            <span class="title">🚀 Tembak Rudal Homing</span>
                            <span class="sub">Mengunci & Jatuhkan Leader #1</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #facc15;" onclick="simGift('banana', 5)">
                            <span class="title">🍌 Pasang Kulit Pisang</span>
                            <span class="sub">Jebakan berputar 360° di aspal</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #00f2fe;" onclick="simGift('shield', 10)">
                            <span class="title">🛡️ Aktifkan Bubble Shield</span>
                            <span class="sub">Kebal & tangkis 1 serangan</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #eab308;" onclick="simGift('lightning', 20)">
                            <span class="title">⚡ Sambaran Petir Zeus</span>
                            <span class="sub">Sengat semua pelari di depan</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #38bdf8;" onclick="simGift('freeze', 15)">
                            <span class="title">🧊 Rudal Es (Freeze Depan)</span>
                            <span class="sub">Bekukan pelari tepat di depan</span>
                        </button>
                        <button class="btn-action" style="border-left: 4px solid #f43f5e;" onclick="simGift('dizzy', 10)">
                            <span class="title">😵 Pusing Overheat (Merah)</span>
                            <span class="sub">Avatar merah & sempoyongan</span>
                        </button>
                    </div>

                    <div style="display: flex; gap: 10px; margin-top: 14px;">
                        <button class="btn-action" style="flex: 1; border-left: 4px solid #eab308;" onclick="simRaceControl('start')">
                            <span class="title">🏁 Paksa Mulai Balapan</span>
                            <span class="sub">Lewati timer countdown</span>
                        </button>
                        <button class="btn-action" style="flex: 1; border-left: 4px solid #ef4444;" onclick="simRaceControl('reset')">
                            <span class="title">🔄 Reset Ronde</span>
                            <span class="sub">Kembalikan ke garis start</span>
                        </button>
                    </div>
                </div>

                <!-- PETUNJUK PENONTON -->
                <div class="guide-box">
                    <strong>📢 Cara Penonton Main di Live TikTok Kamu:</strong>
                    <ol style="margin-left: 18px; margin-top: 8px;">
                        <li><strong>Daftar Lomba:</strong> Cukup ketik <code>@username</code> (TikTok / Roblox) di kolom komentar Live.</li>
                        <li><strong>Lari Cepat (Gift):</strong> Kirim gift apa saja! Semakin besar gift, semakin melesat avatar penonton tersebut!</li>
                        <li><strong>Tap Layar (Likes):</strong> Tap terus layar live untuk memberi tambahan dorongan lari!</li>
                    </ol>
                </div>
            </div>

            <!-- KOLOM KANAN: LIVE EVENT FEED -->
            <div>
                <div class="card" style="height: 100%;">
                    <h2>⚡ Live Event Feed (Roblox Bridge)</h2>
                    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
                        Aktivitas real-time yang sedang dikirimkan ke Roblox Studio:
                    </p>
                    <div class="feed-container" id="feedContainer">
                        <div class="feed-item">
                            <span>⏳ Menunggu event atau klik tombol simulator di sebelah kiri...</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentRunners = ['BudiSpeed', 'SitiTurbo', 'RizkyRunner', 'AsepSupersonic'];

        // Ambil username tersimpan dari localStorage saat halaman dibuka
        window.addEventListener('DOMContentLoaded', () => {
            const saved = localStorage.getItem('saved_tiktok_user');
            const input = document.getElementById('usernameInput');
            if (saved && input && (!input.value || input.value === 'ganti_dengan_username_tiktokmu')) {
                input.value = saved;
            }
        });

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                const alertBox = document.getElementById('connectionAlert');
                const btnConnect = document.getElementById('btnConnect');
                
                dot.className = 'status-dot';
                
                if (data.connectionStatus === 'CONNECTED') {
                    dot.className = 'status-dot';
                    text.innerText = 'ONLINE: @' + data.tiktokUsername;
                    if (btnConnect) {
                        btnConnect.innerText = 'Tersambung';
                        btnConnect.style.background = '#10b981';
                    }
                    if (alertBox) {
                        alertBox.className = 'status-alert-box connected';
                        alertBox.innerHTML = '<div><strong>✅ TERHUBUNG KE TIKTOK LIVE!</strong></div>' +
                            '<div>Akun: <strong>@' + data.tiktokUsername + '</strong> &bull; Room ID: <code>' + (data.roomId || 'Active') + '</code></div>' +
                            '<div style="font-size: 11px; opacity: 0.9;">Chat komentar (@username), Gift, dan Like penonton sekarang langsung mengendalikan pelari di Roblox Studio secara real-time!</div>' +
                            '<button class="btn-disconnect" onclick="disconnectTikTok()">Putuskan Koneksi</button>';
                    }
                } else if (data.connectionStatus === 'CONNECTING') {
                    dot.className = 'status-dot connecting';
                    text.innerText = 'MENGHUBUNGKAN...';
                    if (btnConnect) {
                        btnConnect.innerText = 'Mencari...';
                        btnConnect.style.background = '#f59e0b';
                    }
                    if (alertBox) {
                        alertBox.className = 'status-alert-box connecting';
                        alertBox.innerHTML = '<div><strong>⏳ Sedang mencari siaran Live @' + data.tiktokUsername + '...</strong></div>' +
                            '<div style="font-size: 11px;">Menghubungkan ke Webcast TikTok. Mohon tunggu beberapa detik...</div>';
                    }
                } else {
                    if (btnConnect) {
                        btnConnect.innerText = 'Hubungkan';
                        btnConnect.style.background = '';
                    }
                    if (data.lastError) {
                        dot.className = 'status-dot disconnected';
                        text.innerText = 'OFFLINE / SIMULATOR';
                        if (alertBox) {
                            alertBox.className = 'status-alert-box error';
                            let explanation = 'Akun @' + data.tiktokUsername + ' sedang tidak live atau tidak ditemukan.';
                            if (data.lastError.includes('user_not_found') || data.lastError.includes('LIVE has ended')) {
                                explanation = '⚠️ Akun <strong>@' + data.tiktokUsername + '</strong> sedang <strong>TIDAK LIVE</strong> di TikTok. Pastikan Anda sudah klik <em>"Go Live"</em> di TikTok Live Studio / HP terlebih dahulu.';
                            } else {
                                explanation = '⚠️ ' + data.lastError;
                            }
                            alertBox.innerHTML = '<div><strong>⚠️ Belum Terhubung ke Live TikTok</strong></div>' +
                                '<div>' + explanation + '</div>' +
                                '<div style="font-size: 11px; opacity: 0.85; margin-top: 4px;">🎮 Game saat ini berjalan dalam <strong>Mode Simulator</strong> (tombol-tombol di bawah tetap berfungsi penuh).</div>';
                        }
                    } else {
                        dot.className = 'status-dot connecting';
                        text.innerText = 'SIMULATOR MODE';
                        if (alertBox) {
                            alertBox.className = 'status-alert-box simulator';
                            alertBox.innerHTML = '<div><strong>🎮 Mode Simulator Siap</strong></div>' +
                                '<div>Masukkan username TikTok Anda di atas dan klik <strong>Hubungkan</strong> saat Anda sedang siaran Live.</div>';
                        }
                    }
                }

                // Update Badges Timer & Laps
                if (data.currentLobbyTimer) {
                    const b = document.getElementById('activeTimerBadge');
                    if (b) b.innerText = data.currentLobbyTimer + ' Detik';
                }
                if (data.currentLaps) {
                    const b = document.getElementById('activeLapsBadge');
                    if (b) b.innerText = data.currentLaps + ' Lap' + (data.currentLaps > 1 ? 's' : '');
                }

                // Render feeds
                if (data.recentEvents && data.recentEvents.length > 0) {
                    const container = document.getElementById('feedContainer');
                    container.innerHTML = data.recentEvents.map(e => {
                        let badgeClass = e.type;
                        let desc = '';
                        if (e.type === 'join') {
                            desc = \`<strong>\${e.nickname}</strong> mendaftar race (Roblox: \${e.robloxUser})\`;
                        } else if (e.type === 'gift') {
                            desc = \`🎁 <strong>\${e.nickname}</strong> kirim <strong>\${e.giftName}</strong> (\${e.title})\`;
                        } else if (e.type === 'like') {
                            desc = \`❤️ <strong>\${e.nickname}</strong> tap layar x\${e.likeCount}\`;
                        } else if (e.type === 'command') {
                            if (e.command === 'set_lobby_timer') {
                                desc = \`⏱️ Setting: Timer pendaftaran diubah jadi <strong>\${e.seconds} detik</strong>\`;
                            } else if (e.command === 'set_laps') {
                                desc = \`🏁 Setting: Jumlah putaran diubah jadi <strong>\${e.laps} lap</strong>\`;
                            } else if (e.command === 'start') {
                                desc = '🏁 Perintah: <strong>Mulai Balapan Sekarang</strong>';
                            } else if (e.command === 'reset') {
                                desc = '🔄 Perintah: <strong>Reset Ronde Baru</strong>';
                            } else {
                                desc = \`⚡ Perintah Server: <strong>\${e.command}</strong>\`;
                            }
                        }
                        return \`<div class="feed-item \${badgeClass}">
                            <span>\${desc}</span>
                            <small style="color: #64748b;">\${new Date(e.timestamp).toLocaleTimeString()}</small>
                        </div>\`;
                    }).join('');
                }
            } catch (err) {
                console.error('Fetch status error:', err);
            }
        }

        async function updateUsername() {
            const input = document.getElementById('usernameInput');
            const username = input.value.trim().replace(/^@/, '');
            if (!username) {
                alert('Silakan masukkan username TikTok Anda');
                return;
            }
            localStorage.setItem('saved_tiktok_user', username);
            
            const btnConnect = document.getElementById('btnConnect');
            if (btnConnect) {
                btnConnect.innerText = 'Mencari...';
                btnConnect.style.background = '#f59e0b';
            }

            await fetch('/api/set-username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            setTimeout(updateStatus, 600);
        }

        async function disconnectTikTok() {
            await fetch('/api/disconnect', { method: 'POST' });
            updateStatus();
        }

        async function simBatchJoin(count = 25) {
            await fetch('/test/spawn-batch?count=' + count);
            updateStatus();
        }

        async function simJoin() {
            const r = Math.floor(100 + Math.random() * 900);
            const user = 'Viewer_' + r;
            currentRunners.push(user);
            await fetch('/test/join?user=' + user);
            updateStatus();
        }

        async function simGift(gift, diamonds) {
            const target = currentRunners.length > 0 ? currentRunners[Math.floor(Math.random() * currentRunners.length)] : 'Viewer_1';
            await fetch(\`/test/gift?user=\${target}&gift=\${gift}&diamonds=\${diamonds}\`);
            updateStatus();
        }

        async function simLike() {
            const target = currentRunners.length > 0 ? currentRunners[Math.floor(Math.random() * currentRunners.length)] : 'Viewer_1';
            await fetch(\`/test/like?user=\${target}&count=5\`);
            updateStatus();
        }

        async function simRaceControl(cmd) {
            await fetch('/test/race-control?cmd=' + cmd);
            updateStatus();
        }

        async function setTimerPreset(sec) {
            await fetch('/test/set-settings?timer=' + sec);
            const inp = document.getElementById('customTimerInput');
            if (inp) inp.value = sec;
            updateStatus();
        }

        async function applyCustomTimer() {
            const val = parseInt(document.getElementById('customTimerInput').value, 10);
            if (val && val >= 5) {
                await fetch('/test/set-settings?timer=' + val);
                updateStatus();
            } else {
                alert('Timer pendaftaran minimal 5 detik!');
            }
        }

        async function setLapsPreset(laps) {
            await fetch('/test/set-settings?laps=' + laps);
            const inp = document.getElementById('customLapsInput');
            if (inp) inp.value = laps;
            updateStatus();
        }

        async function applyCustomLaps() {
            const val = parseInt(document.getElementById('customLapsInput').value, 10);
            if (val && val >= 1) {
                await fetch('/test/set-settings?laps=' + val);
                updateStatus();
            } else {
                alert('Jumlah putaran minimal 1 lap!');
            }
        }

        async function loadCustomEffects() {
            try {
                const res = await fetch('/api/config/effects');
                const data = await res.json();
                if (data && data.config) {
                    const c = data.config;
                    if (c.tier1) {
                        document.getElementById('cfg_t1_speed').value = c.tier1.speed;
                        document.getElementById('cfg_t1_dur').value = c.tier1.duration;
                    }
                    if (c.tier2) {
                        document.getElementById('cfg_t2_speed').value = c.tier2.speed;
                        document.getElementById('cfg_t2_dur').value = c.tier2.duration;
                    }
                    if (c.tier3) {
                        document.getElementById('cfg_t3_speed').value = c.tier3.speed;
                        document.getElementById('cfg_t3_dur').value = c.tier3.duration;
                    }
                    if (c.like) {
                        document.getElementById('cfg_like_speed').value = c.like.speed;
                        document.getElementById('cfg_like_dur').value = c.like.duration;
                    }
                    if (c.missile) document.getElementById('cfg_missile_dur').value = c.missile.duration;
                    if (c.nuke) document.getElementById('cfg_nuke_dur').value = c.nuke.duration;
                    if (c.freeze) document.getElementById('cfg_freeze_dur').value = c.freeze.duration;
                    if (c.dizzy) document.getElementById('cfg_dizzy_dur').value = c.dizzy.duration;
                    if (c.lightning) document.getElementById('cfg_lightning_dur').value = c.lightning.duration;
                    if (c.banana) document.getElementById('cfg_banana_dur').value = c.banana.duration;
                    if (c.shield) document.getElementById('cfg_shield_dur').value = c.shield.duration;

                    if (c.triggers) {
                        if (document.getElementById('trig_tier1')) document.getElementById('trig_tier1').value = c.triggers.tier1_gifts || '';
                        if (document.getElementById('trig_missile')) document.getElementById('trig_missile').value = c.triggers.missile || '';
                        if (document.getElementById('trig_nuke')) document.getElementById('trig_nuke').value = c.triggers.nuke || '';
                        if (document.getElementById('trig_freeze')) document.getElementById('trig_freeze').value = c.triggers.freeze || '';
                        if (document.getElementById('trig_dizzy')) document.getElementById('trig_dizzy').value = c.triggers.dizzy || '';
                        if (document.getElementById('trig_lightning')) document.getElementById('trig_lightning').value = c.triggers.lightning || '';
                        if (document.getElementById('trig_banana')) document.getElementById('trig_banana').value = c.triggers.banana || '';
                        if (document.getElementById('trig_shield')) document.getElementById('trig_shield').value = c.triggers.shield || '';
                        if (document.getElementById('trig_tier2')) document.getElementById('trig_tier2').value = c.triggers.tier2_gifts || '';
                        if (document.getElementById('trig_tier3')) document.getElementById('trig_tier3').value = c.triggers.tier3_gifts || '';
                    }
                }
            } catch (e) {
                console.error('Gagal memuat pengaturan efek:', e);
            }
        }

        async function saveCustomEffects() {
            const payload = {
                tier1: {
                    speed: parseFloat(document.getElementById('cfg_t1_speed').value) || 18,
                    duration: parseFloat(document.getElementById('cfg_t1_dur').value) || 3.5
                },
                tier2: {
                    speed: parseFloat(document.getElementById('cfg_t2_speed').value) || 38,
                    duration: parseFloat(document.getElementById('cfg_t2_dur').value) || 5.0
                },
                tier3: {
                    speed: parseFloat(document.getElementById('cfg_t3_speed').value) || 75,
                    duration: parseFloat(document.getElementById('cfg_t3_dur').value) || 7.0
                },
                like: {
                    speed: parseFloat(document.getElementById('cfg_like_speed').value) || 4,
                    duration: parseFloat(document.getElementById('cfg_like_dur').value) || 1.2
                },
                missile: { duration: parseFloat(document.getElementById('cfg_missile_dur').value) || 3.0 },
                nuke: { duration: parseFloat(document.getElementById('cfg_nuke_dur').value) || 4.0 },
                freeze: { duration: parseFloat(document.getElementById('cfg_freeze_dur').value) || 2.8 },
                dizzy: { duration: parseFloat(document.getElementById('cfg_dizzy_dur').value) || 3.2 },
                lightning: { duration: parseFloat(document.getElementById('cfg_lightning_dur').value) || 2.5 },
                banana: { duration: parseFloat(document.getElementById('cfg_banana_dur').value) || 2.0 },
                shield: { duration: parseFloat(document.getElementById('cfg_shield_dur').value) || 8.0 },
                triggers: {
                    tier1_gifts: document.getElementById('trig_tier1') ? document.getElementById('trig_tier1').value : '',
                    missile: document.getElementById('trig_missile') ? document.getElementById('trig_missile').value : '',
                    nuke: document.getElementById('trig_nuke') ? document.getElementById('trig_nuke').value : '',
                    freeze: document.getElementById('trig_freeze') ? document.getElementById('trig_freeze').value : '',
                    dizzy: document.getElementById('trig_dizzy') ? document.getElementById('trig_dizzy').value : '',
                    lightning: document.getElementById('trig_lightning') ? document.getElementById('trig_lightning').value : '',
                    banana: document.getElementById('trig_banana') ? document.getElementById('trig_banana').value : '',
                    shield: document.getElementById('trig_shield') ? document.getElementById('trig_shield').value : '',
                    tier2_gifts: document.getElementById('trig_tier2') ? document.getElementById('trig_tier2').value : '',
                    tier3_gifts: document.getElementById('trig_tier3') ? document.getElementById('trig_tier3').value : ''
                }
            };

            const res = await fetch('/api/config/effects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data && data.success) {
                const badge = document.getElementById('fxSaveStatus');
                if (badge) {
                    badge.style.display = 'inline-block';
                    badge.innerText = '✅ Tersimpan!';
                    setTimeout(() => { badge.style.display = 'none'; }, 2500);
                }
            }
        }

        async function resetCustomEffects() {
            if (!confirm('Kembalikan semua kecepatan boost dan durasi sabotase ke nilai default?')) return;
            const res = await fetch('/api/config/effects/reset', { method: 'POST' });
            const data = await res.json();
            if (data && data.success) {
                await loadCustomEffects();
                const badge = document.getElementById('fxSaveStatus');
                if (badge) {
                    badge.style.display = 'inline-block';
                    badge.innerText = '🔄 Di-reset!';
                    setTimeout(() => { badge.style.display = 'none'; }, 2500);
                }
            }
        }

        setInterval(updateStatus, 1000);
        updateStatus();
        loadCustomEffects();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log('========================================================');
    console.log('🚀 TIKTOK BALAP LARI BRIDGE SERVER BERJALAN!');
    console.log(`🌐 Dashboard Streamer: http://localhost:${PORT}`);
    console.log(`📡 Endpoint Roblox:    http://127.0.0.1:${PORT}/api/actions`);
    console.log('========================================================');
});
