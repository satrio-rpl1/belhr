/* =====================================================
   ALARM PRO — sw.js  (Service Worker)
   Handles background alarm notifications when the
   browser tab is closed / in the background.
   ===================================================== */

const CACHE_NAME = 'alarmpro-v2';
const SW_ALARM_KEY = 'sw_alarms';

// In-memory copy of alarms (persisted in SW while alive)
let swAlarms = [];
let swCheckInterval = null;

// ─── INSTALL & ACTIVATE ──────────────────────────────
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

// ─── MESSAGE FROM PAGE ───────────────────────────────
// The page sends { type: 'SYNC_ALARMS', alarms: [...] } every time alarms change
self.addEventListener('message', event => {
    if (!event.data) return;

    if (event.data.type === 'SYNC_ALARMS') {
        swAlarms = event.data.alarms || [];
        startAlarmCheck();
    }

    if (event.data.type === 'DISMISS_ALARM') {
        // Page dismissed the alarm, nothing extra needed in SW
    }
});

// ─── ALARM CHECKER ───────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function startAlarmCheck() {
    if (swCheckInterval) clearInterval(swCheckInterval);
    // Check every 30 seconds — SW stays alive while there's an interval running
    swCheckInterval = setInterval(checkSwAlarms, 30000);
    // Also check immediately
    checkSwAlarms();
}

const swFiredKeys = {};
let swLastMinute = null;

function checkSwAlarms() {
    const now = new Date();
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = now.getSeconds();
    const currentMinute = `${hh}:${mm}`;
    const currentDay = now.getDay();

    // Purge old fired keys on minute rollover
    if (currentMinute !== swLastMinute) {
        swLastMinute = currentMinute;
        for (const k in swFiredKeys) {
            if (!k.endsWith('|' + currentMinute)) delete swFiredKeys[k];
        }
    }

    // Only fire within first 30 seconds of the minute
    if (ss > 30) return;

    for (const alarm of swAlarms) {
        if (!alarm.enabled) continue;
        if (alarm.time !== currentMinute) continue;

        const hasDays = Array.isArray(alarm.days) && alarm.days.length > 0;
        if (hasDays && !alarm.days.includes(currentDay)) continue;

        const key = alarm.id + '|' + currentMinute;
        if (swFiredKeys[key]) continue;

        swFiredKeys[key] = true;
        showAlarmNotification(alarm);
        break;
    }
}

// ─── SHOW NOTIFICATION ───────────────────────────────
function showAlarmNotification(alarm) {
    // First check if there's an active focused client (page is visible)
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const hasFocusedClient = clients.some(c => c.focused);

        // Always show OS notification (even if page is open — page will also show its own overlay)
        const title = `⏰ Alarm: ${alarm.name || 'Alarm'}`;
        const options = {
            body: `Waktunya ${alarm.time} — ${alarm.name || 'Alarm'}`,
            icon: '/timer/icon-192.png',
            badge: '/timer/icon-192.png',
            tag: 'alarmpro-' + alarm.id,
            renotify: true,
            requireInteraction: true,   // stays until user interacts
            vibrate: [300, 100, 300, 100, 300],
            data: { alarmId: alarm.id, alarmTime: alarm.time, alarmName: alarm.name },
            actions: [
                { action: 'dismiss', title: '✖ Matikan' }
            ],
        };

        self.registration.showNotification(title, options).catch(err => {
            console.warn('[SW] showNotification failed:', err);
        });

        // Also notify any open clients so their in-app overlay shows too
        clients.forEach(client => {
            client.postMessage({ type: 'ALARM_FIRED', alarm });
        });
    });
}

// ─── NOTIFICATION CLICK ──────────────────────────────
self.addEventListener('notificationclick', event => {
    const notification = event.notification;
    const action = event.action;
    const alarm = notification.data;

    notification.close();

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // Focus existing tab or open new one
            const targetUrl = '/timer/';
            const existing = clients.find(c => c.url.includes('/timer/'));

            const focusOrOpen = existing
                ? existing.focus().then(c => c.postMessage({ type: 'ALARM_ACTION', action, alarm }))
                : self.clients.openWindow(targetUrl).then(newClient => {
                    // Wait for the page to load, then send action
                    if (newClient) {
                        setTimeout(() => {
                            newClient.postMessage({ type: 'ALARM_ACTION', action, alarm });
                        }, 1500);
                    }
                });

            return focusOrOpen;
        })
    );
});

// ─── NOTIFICATION CLOSE ──────────────────────────────
self.addEventListener('notificationclose', event => {
    // User swiped away the notification — treat as dismiss
});

// ─── KEEP ALIVE TRICK ────────────────────────────────
// Respond to fetch events from our own keepalive pings
self.addEventListener('fetch', event => {
    if (event.request.url.includes('sw-keepalive')) {
        event.respondWith(new Response('ok', { headers: { 'Content-Type': 'text/plain' } }));
    }
});
