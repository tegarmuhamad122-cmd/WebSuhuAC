/* =====================================================================
 *  Simulasi Monitoring Suhu AC + Remote Control
 *  Server HTTP + MQTT WebSocket + ESP32
 *
 *  Arsitektur:
 *
 *  Browser HP/PC
 *       │
 *       ├── HTTP ────────> server.py
 *       │                     │
 *       │                     └── MQTT ──> ESP32
 *       │
 *       └── MQTT WebSocket TLS ──> EMQX Cloud
 *                                      │
 *                                      └── monitoring ESP32
 *
 *  Catatan:
 *  - Browser TIDAK mengirim ac/control secara langsung.
 *  - server.py tetap menjadi pengirim perintah kontrol ke ESP32.
 *  - MQTT WebSocket digunakan browser untuk membaca status ESP32.
 * ===================================================================== */

'use strict';


/* =====================================================================
 *  KONSTANTA
 * ===================================================================== */

const TEMP_MIN = 16;
const TEMP_MAX = 30;

const ROOM_MIN = 10;
const ROOM_MAX = 45;

const HIST_MAX  = 300;
const HIST_STEP = 2;
const SIM_START = 20 * 3600;

const MODE_ORDER = ['AUTO', 'COOL', 'DRY', 'FAN', 'HEAT'];

const MODE_LABEL = {
  AUTO: 'AUTO',
  COOL: 'COOL',
  DRY: 'DRY',
  FAN: 'FAN',
  HEAT: 'HEAT'
};

const MODE_ICON = {
  AUTO: 'A',
  COOL: '❄',
  DRY: '💧',
  FAN: '✵',
  HEAT: '☀'
};

const FAN_ORDER = ['AUTO', 'LOW', 'MED', 'HIGH'];

const FAN_LABEL = {
  AUTO: 'AUTO',
  LOW: 'LOW',
  MED: 'MED',
  HIGH: 'HIGH'
};

const FAN_FACTOR = {
  AUTO: 0.85,
  LOW: 0.60,
  MED: 0.85,
  HIGH: 1.15
};

const FAN_WATT = {
  AUTO: 35,
  LOW: 25,
  MED: 45,
  HIGH: 65
};

const MODE_K = {
  AUTO: 0.022,
  COOL: 0.022,
  DRY: 0.010,
  FAN: 0,
  HEAT: 0.016
};

const MODE_WATT = {
  AUTO: 720,
  COOL: 720,
  DRY: 520,
  FAN: 0,
  HEAT: 980
};

const TIMER_STEPS = [0, 30, 60, 120, 240, 480];

const TIMER_TEXT = {
  0: 'OFF',
  30: '30m',
  60: '1j',
  120: '2j',
  240: '4j',
  480: '8j'
};

const HYST = 0.35;
const SLEEP_DELAY = 3600;


/* =====================================================================
 *  MQTT
 * ===================================================================== */

/*
 * MQTT.js akan dimuat otomatis.
 *
 * Browser:
 *   wss://h212d01c.ala.us-east-1.emqxsl.com:8084/mqtt
 *
 * MQTT menggunakan EMQX Cloud.
 *
 * Browser tetap hanya membaca status ESP32.
 * Kontrol utama tetap melalui server.py.
 */

const MQTT_CONFIG = {
  libraryUrl: 'https://unpkg.com/mqtt@5.10.4/dist/mqtt.min.js',

  host: 'h212d01c.ala.us-east-1.emqxsl.com',
  port: 8084,

  username: 'WebSuhuAC',
  password: 'Jakarta1928',

  topics: {
    control: 'ac/control',
    status: 'ac/status',
    temperature: 'ac/temperature',
    target: 'ac/target',
    mode: 'ac/mode',
    fan: 'ac/fan'
  },

  reconnectPeriod: 5000,
  connectTimeout: 10000
};

const MQTT = {
  client: null,

  libraryLoaded: false,
  loading: false,

  connected: false,
  connecting: false,

  host: '',
  url: '',

  lastStatus: null,
  lastTemperature: null,
  lastTarget: null,
  lastMode: null,

  lastMessageAt: 0,

  error: '',
  reconnectCount: 0,

  /*
   * Status ESP32 tidak langsung menggantikan S.power.
   * S tetap menjadi state simulasi/server.
   * MQTT menyimpan status ESP32 secara terpisah.
   */
  espStatus: null,

  initialized: false
};


/* =====================================================================
 *  STATE SIMULASI
 * ===================================================================== */

const S = {
  power: false,
  setTemp: 24,

  esp32Temperature: null,
  mode: 'COOL',
  fan: 'AUTO',
  swing: false,
  turbo: false,
  sleep: false,
  sleepElapsed: 0,
  timerIdx: 0,
  timerRemaining: 0,

  room: 30.4,
  outdoor: 32,
  hum: 66,
  outdoorHum: 68,

  compressor: false,
  powerW: 2,
  energyKwh: 0,
  cost: 0,

  simTime: SIM_START,
  speed: 5,
  running: true,
  tariff: 1444.7,

  hist: [],
  histAcc: HIST_STEP,
  duration: 0,

  baseline: 30.4
};


/* =====================================================================
 *  UTILITAS
 * ===================================================================== */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const $ = id => document.getElementById(id);

const rupiah = n =>
  'Rp ' + Math.round(n).toLocaleString('id-ID');

const pad2 = n =>
  String(n).padStart(2, '0');


function clockText(t) {
  const s = Math.floor(t % 86400);

  return (
    pad2(Math.floor(s / 3600)) +
    ':' +
    pad2(Math.floor((s % 3600) / 60)) +
    ':' +
    pad2(s % 60)
  );
}


function clockShort(t) {
  const s = Math.floor(t % 86400);

  return (
    pad2(Math.floor(s / 3600)) +
    ':' +
    pad2(Math.floor((s % 3600) / 60))
  );
}

function waktuNyataText() {
  const now = new Date();

  const hari = [
    'Minggu',
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat',
    'Sabtu'
  ];

  const bulan = [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember'
  ];

  return (
    hari[now.getDay()] +
    ', ' +
    now.getDate() +
    ' ' +
    bulan[now.getMonth()] +
    ' ' +
    now.getFullYear() +
    ' - ' +
    pad2(now.getHours()) +
    ':' +
    pad2(now.getMinutes()) +
    ':' +
    pad2(now.getSeconds())
  );
}


function waktuNyataShort() {
  const now = new Date();

  return (
    pad2(now.getHours()) +
    ':' +
    pad2(now.getMinutes())
  );
}


function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return m > 0 ? `${h}j ${m}m` : `${h}j`;
  }

  if (m > 0) {
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }

  return `${s}s`;
}


/* =====================================================================
 *  DOM
 * ===================================================================== */

const el = {
  clock: $('clock'),

  statusBadge: $('statusBadge'),
  statusText: $('statusText'),

  btnPowerMain: $('btnPowerMain'),
  btnPowerLabel: $('btnPowerLabel'),

  roomTemp: $('roomTemp'),
  roomSub: $('roomSub'),
  roomState: $('roomState'),

  chipComp: $('chipComp'),
  chipTrend: $('chipTrend'),

  stSet: $('stSet'),
  stOut: $('stOut'),
  stHum: $('stHum'),
  stPower: $('stPower'),
  stEnergy: $('stEnergy'),
  stCost: $('stCost'),

  barProg: $('barProg'),
  barProgVal: $('barProgVal'),

  barPower: $('barPower'),
  barPowerVal: $('barPowerVal'),

  barHum: $('barHum'),
  barHumVal: $('barHumVal'),

  chart: $('chart'),

  remoteScreen: $('remoteScreen'),
  rsPower: $('rsPower'),
  rsClock: $('rsClock'),
  rsTemp: $('rsTemp'),
  rsTempBox: $('rsTempBox'),
  rsMode: $('rsMode'),
  rsFan: $('rsFan'),
  rsSwing: $('rsSwing'),
  rsTimer: $('rsTimer'),
  rsTurbo: $('rsTurbo'),
  rsSleep: $('rsSleep'),

  chipRemote: $('chipRemote'),

  acIndoor: $('acIndoor'),
  acLouver: $('acLouver'),
  acLed: $('acLed'),

  indoorDisplay:
    document.querySelector('.indoor-display span'),

  airflow: $('airflow'),

  outFan: $('outFan'),
  acOutdoor: $('acOutdoor'),

  chipUnit: $('chipUnit'),
  umStatus: $('umStatus'),
  umComp: $('umComp'),
  umMode: $('umMode'),
  umFan: $('umFan'),
  umSwing: $('umSwing'),
  umTimer: $('umTimer'),

  logList: $('logList'),
  toast: $('toast'),

  netBadge: $('netBadge'),
  netText: $('netText'),

  netBanner: $('netBanner'),
  nbTitle: $('nbTitle'),
  nbDesc: $('nbDesc'),
  nbInput: $('nbInput'),
  nbConnect: $('nbConnect'),
  nbRetry: $('nbRetry'),
  nbClose: $('nbClose'),

  rngOutdoor: $('rngOutdoor'),
  valOutdoor: $('valOutdoor'),

  rngHumOut: $('rngHumOut'),
  valHumOut: $('valHumOut'),

  selSpeed: $('selSpeed'),
  inpTariff: $('inpTariff'),

  btnFF: $('btnFF'),
  btnPause: $('btnPause'),

  btnResetAll: $('btnResetAll'),
  btnClearLog: $('btnClearLog')
};


const remoteButtons =
  Array.from(document.querySelectorAll('.rbtn[data-act]'));


/* =====================================================================
 *  MODE SERVER
 * ===================================================================== */

const NET = {
  mode: 'server',

  base: '',

  online: false,

  pending: false,

  lastPoll: 0,

  pollMs: 600,

  retryMs: 5000,
  
  lastRetry: 0,

  fail: 0,

  clients: 1,

  logKey: '',

  alamatBawaan: '',

  alamatDicoba: '',

  bannerTutup: false,

  bannerAlamat: ''
};


/* =====================================================================
 *  ALAMAT SERVER
 * ===================================================================== */

function rapikanAlamat(teks) {
  let s = String(teks || '')
    .trim()
    .replace(/\s+/g, '');

  if (!s) return '';

  if (!/^https?:\/\//i.test(s)) {
    s = 'http://' + s;
  }

  s = s.replace(/\/[^/]*\.html?$/i, '');

  s = s.replace(/\/+$/, '');

  const tanpaSkema =
    s.replace(/^https?:\/\//i, '');

  if (
    tanpaSkema &&
    !/:\d+$/.test(tanpaSkema)
  ) {
    s += ':8080';
  }

  return s;
}


function alamatTersimpan() {
  try {
    return rapikanAlamat(
      localStorage.getItem('ac-server') || ''
    );
  } catch (e) {
    return '';
  }
}


function simpanAlamat(alamat) {
  try {
    localStorage.setItem(
      'ac-server',
      alamat
    );
  } catch (e) {
    /* mode privat */
  }
}


/* =====================================================================
 *  KANDIDAT SERVER
 * ===================================================================== */

function kandidatServer() {
  const disajikanServer =
    location.protocol === 'http:' ||
    location.protocol === 'https:';

  const daftar = [];

  const tambah = a => {
    const r = rapikanAlamat(a);

    if (
      r &&
      daftar.indexOf(r) < 0
    ) {
      daftar.push(r);
    }
  };

  if (disajikanServer) {
    tambah(location.origin);
  }

  tambah(alamatTersimpan());

  tambah(NET.alamatBawaan);

  if (!disajikanServer) {
    tambah('http://127.0.0.1:8080');
  }

  return daftar;
}


/* =====================================================================
 *  HTTP API
 * ===================================================================== */

async function apiGet(base, path, timeoutMs) {
  const ctrl =
    typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;

  const timer = ctrl
    ? setTimeout(
        () => ctrl.abort(),
        timeoutMs || 3000
      )
    : null;

  try {
    const r = await fetch(
      base + path,
      ctrl
        ? {
            cache: 'no-store',
            signal: ctrl.signal
          }
        : {
            cache: 'no-store'
          }
    );

    if (!r.ok) {
      throw new Error(
        'HTTP ' + r.status
      );
    }

    return await r.json();

  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}


async function apiPost(path, body) {
  const r = await fetch(
    NET.base + path,
    {
      method: 'POST',
      cache: 'no-store',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify(body)
    }
  );

  if (!r.ok) {
    throw new Error(
      'HTTP ' + r.status
    );
  }

  return await r.json();
}


/* =====================================================================
 *  DETEKSI SERVER
 * ===================================================================== */

async function detectServer() {
  const daftar =
    kandidatServer();

  for (const base of daftar) {
    try {
      const st =
        await apiGet(
          base,
          '/api/state',
          2500
        );

      if (st && st.ok) {
        const baru =
          NET.mode !== 'server';

        NET.base = base;
        NET.mode = 'server';
        NET.online = true;
        NET.fail = 0;
        NET.logKey = '';
        NET.bannerTutup = false;
        NET.alamatDicoba = '';

        applyState(st);

        if (baru) {
          toast(
            'Tersambung ke server ' +
            base.replace(
              /^https?:\/\//,
              ''
            ),
            'good'
          );
        }

        return true;
      }

    } catch (e) {
      /* coba kandidat berikutnya */
    }
  }

  NET.mode = 'local';
  NET.online = false;
  NET.fail = 0;

  NET.alamatDicoba =
    daftar[0] || '';

  NET.bannerTutup = false;  

  return false;
}


/* =====================================================================
 *  SAMBUNG MANUAL
 * ===================================================================== */

async function sambungKe(alamat) {
  const base =
    rapikanAlamat(alamat);

  if (!base) {
    toast(
      'Alamat server belum diisi',
      'warn'
    );

    return false;
  }

  toast(
    'Mencoba ' +
    base.replace(
      /^https?:\/\//,
      ''
    ) +
    '…'
  );

  try {
    const st =
      await apiGet(
        base,
        '/api/state',
        4000
      );

    if (st && st.ok) {
      NET.base = base;
      NET.mode = 'server';
      NET.online = true;
      NET.fail = 0;
      NET.logKey = '';
      NET.bannerTutup = false;

      simpanAlamat(base);

      applyState(st);

      toast(
        'Tersambung ke ' +
        base.replace(
          /^https?:\/\//,
          ''
        ),
        'good'
      );

      return true;
    }

  } catch (e) {
    /* gagal */
  }

  NET.alamatDicoba = base;
  NET.bannerTutup = false;

  toast(
    'Gagal menyambung ke ' +
    base.replace(
      /^https?:\/\//,
      ''
    ),
    'warn'
  );

  return false;
}


/* =====================================================================
 *  APPLY STATE SERVER
 * ===================================================================== */

function applyState(st) {
  S.power = !!st.power;

  if (st.setTemp != null)
    S.setTemp = st.setTemp;

  if (st.mode)
    S.mode = st.mode;

  if (st.fan)
    S.fan = st.fan;

  S.swing = !!st.swing;
  S.turbo = !!st.turbo;
  S.sleep = !!st.sleep;

  S.sleepElapsed =
    st.sleepElapsed || 0;

  S.timerIdx =
    st.timerIdx || 0;

  S.timerRemaining =
    st.timerRemaining || 0;

  if (st.room != null)
    S.room = st.room;

  if (st.esp32Temperature != null) {
    const tempEsp =
      parseFloat(st.esp32Temperature);

    if (Number.isFinite(tempEsp)) {
      S.esp32Temperature = tempEsp;
    }
  } 

  if (st.outdoor != null)
    S.outdoor = st.outdoor;

  if (st.hum != null)
    S.hum = st.hum;

  if (st.outdoorHum != null)
    S.outdoorHum = st.outdoorHum;

  S.compressor =
    !!st.compressor;

  if (st.powerW != null)
    S.powerW = st.powerW;

  if (st.energyKwh != null)
    S.energyKwh = st.energyKwh;

  if (st.cost != null)
    S.cost = st.cost;

  if (st.simTime != null)
    S.simTime = st.simTime;

  if (st.speed != null)
    S.speed = st.speed;

  S.running =
    st.running !== false;

  if (st.tariff != null)
    S.tariff = st.tariff;

  if (st.baseline != null)
    S.baseline = st.baseline;

  S.duration =
    st.duration || 0;

  if (Array.isArray(st.hist)) {
    S.hist =
      st.hist.map(h => ({
        room: h.room,
        set: h.set,
        comp: !!h.comp
      }));
  }

  NET.clients =
    st.clients || 1;

  if (Array.isArray(st.log)) {
    syncLog(st.log);
  }

  syncSettingInputs();
}


/* =====================================================================
 *  LOG SERVER
 * ===================================================================== */

function syncLog(entries) {
  const kunci =
    entries.length +
    '|' +
    (
      entries[0]
        ? entries[0].t +
          entries[0].text
        : ''
    );

  if (kunci === NET.logKey) {
    return;
  }

  NET.logKey = kunci;

  el.logList.innerHTML = '';

  if (!entries.length) {
    el.logList.innerHTML =
      '<li class="log-empty">' +
      'Belum ada kejadian.' +
      '</li>';

    return;
  }

  for (const e of entries) {
    const li =
      document.createElement('li');

    li.className =
      'k-' +
      (e.kind || 'info');

    const t =
      document.createElement('time');

    t.textContent = e.t;

    li.appendChild(t);

    li.appendChild(
      document.createTextNode(
        e.text
      )
    );

    el.logList.appendChild(li);
  }
}


/* =====================================================================
 *  SETTING INPUT
 * ===================================================================== */

function syncSettingInputs() {
  const aktif =
    document.activeElement;

  if (aktif !== el.rngOutdoor) {
    el.rngOutdoor.value =
      S.outdoor;

    el.valOutdoor.textContent =
      S.outdoor.toFixed(1) +
      ' °C';
  }

  if (aktif !== el.rngHumOut) {
    el.rngHumOut.value =
      S.outdoorHum;

    el.valHumOut.textContent =
      S.outdoorHum.toFixed(0) +
      ' %';
  }

  if (
    aktif !== el.selSpeed &&
    Array.prototype.some.call(
      el.selSpeed.options,
      o =>
        parseFloat(o.value) ===
        S.speed
    )
  ) {
    el.selSpeed.value =
      String(S.speed);
  }

  if (aktif !== el.inpTariff) {
    el.inpTariff.value =
      S.tariff;
  }
}


/* =====================================================================
 *  POLLING SERVER
 * ===================================================================== */

async function pollServer() {
  NET.pending = true;

  try {
    const st =
      await apiGet(
        NET.base,
        '/api/state',
        4000
      );

    if (st && st.ok) {
      applyState(st);

      NET.online = true;
      NET.fail = 0;
    }

  } catch (e) {
    NET.fail++;

    NET.online = false;

    if (NET.fail >= 5) {
      NET.mode = 'local';
      NET.fail = 0;
      NET.online = false;
      NET.fail = 0;

      NET.alamatDicoba =
        NET.base || NET.alamatBawaan || '';

      NET.bannerTutup = false;

      logEvent(
        'Koneksi ke server hilang - beralih ke mode lokal (mandiri)',
        'warn'
      );

      toast(
        'Server terputus - Mode Simulasi Lokal',
        'warn'
      );
    }

  } finally {
    NET.pending = false;
  }
}


/* =====================================================================
 *  ACTION
 * ===================================================================== */

function doAction(name) {
  if (NET.mode !== 'server') {
    const fn =
      ACTIONS[name];

    if (fn) {
      fn();
    }

    render();

    return;
  }

  apiPost(
    '/api/action',
    {
      action: name
    }
  )
    .then(st => {
      if (st && st.ok) {
        applyState(st);

        NET.online = true;
        NET.fail = 0;
      }
    })
    .catch(() => {
      toast(
        'Gagal mengirim perintah ke server',
        'warn'
      );
    });

  render();
}


/* =====================================================================
 *  SERVER SETTINGS
 * ===================================================================== */

let patchTertunda = null;
let patchTimer = null;


function pushSetting(patch) {
  if (NET.mode !== 'server') {
    return;
  }

  patchTertunda =
    Object.assign(
      patchTertunda || {},
      patch
    );

  clearTimeout(patchTimer);

  patchTimer =
    setTimeout(() => {
      const p =
        patchTertunda;

      patchTertunda = null;

      apiPost(
        '/api/settings',
        p
      )
        .then(st => {
          if (st && st.ok) {
            applyState(st);
          }
        })
        .catch(() => {
          toast(
            'Gagal menyimpan pengaturan ke server',
            'warn'
          );
        });

    }, 250);
}


/* =====================================================================
 *  LOG LOKAL
 * ===================================================================== */

function logEvent(text, kind) {
  if (!el.logList) {
    return;
  }

  const empty =
    el.logList.querySelector(
      '.log-empty'
    );

  if (empty) {
    empty.remove();
  }

  const li =
    document.createElement('li');

  li.className =
    'k-' +
    (kind || 'info');

  const t =
    document.createElement('time');

  t.textContent =
    clockShort(S.simTime);

  li.appendChild(t);

  li.appendChild(
    document.createTextNode(
      text
    )
  );

  el.logList.prepend(li);

  while (
    el.logList.children.length >
    60
  ) {
    el.logList.lastElementChild.remove();
  }
}


/* =====================================================================
 *  TOAST
 * ===================================================================== */

let toastTimer = null;


function toast(msg, kind) {
  if (!el.toast) {
    return;
  }

  el.toast.textContent =
    msg;

  el.toast.className =
    'toast show' +
    (
      kind
        ? ' ' + kind
        : ''
    );

  clearTimeout(toastTimer);

  toastTimer =
    setTimeout(() => {
      el.toast.className =
        'toast';
    }, 2400);
}


/* =====================================================================
 *  MQTT HOST
 * ===================================================================== */

function tentukanMqttHost() {
  return MQTT_CONFIG.host;
}


function tentukanMqttUrl() {
  const host =
    tentukanMqttHost();

  MQTT.host = host;

  MQTT.url =
    'wss://' +
    host +
    ':' +
    MQTT_CONFIG.port +
    '/mqtt';

  return MQTT.url;
}


/* =====================================================================
 *  LOAD MQTT.JS
 * ===================================================================== */

function loadMqttLibrary() {
  return new Promise(
    (resolve, reject) => {

      if (
        typeof window.mqtt !==
        'undefined'
      ) {
        MQTT.libraryLoaded = true;
        resolve();

        return;
      }

      if (MQTT.loading) {
        const wait =
          setInterval(() => {

            if (
              typeof window.mqtt !==
              'undefined'
            ) {
              clearInterval(wait);

              MQTT.libraryLoaded =
                true;

              resolve();
            }

          }, 100);

        setTimeout(() => {
          clearInterval(wait);
        }, 10000);

        return;
      }

      MQTT.loading = true;

      const script =
        document.createElement(
          'script'
        );

      script.src =
        MQTT_CONFIG.libraryUrl;

      script.async = true;

      script.onload = () => {
        MQTT.loading = false;

        if (
          typeof window.mqtt !==
          'undefined'
        ) {
          MQTT.libraryLoaded =
            true;

          resolve();
        } else {
          reject(
            new Error(
              'MQTT.js tidak tersedia'
            )
          );
        }
      };

      script.onerror = () => {
        MQTT.loading = false;

        reject(
          new Error(
            'Gagal memuat MQTT.js'
          )
        );
      };

      document.head.appendChild(
        script
      );
    }
  );
}


/* =====================================================================
 *  MQTT STATUS
 * ===================================================================== */

function mqttStatusText() {
  if (!MQTT.connected) {
    if (MQTT.connecting) {
      return 'MQTT menghubungkan…';
    }

    return 'MQTT terputus';
  }

  if (
    MQTT.espStatus === 'ON'
  ) {
    return 'MQTT · ESP32 ON';
  }

  if (
    MQTT.espStatus === 'OFF'
  ) {
    return 'MQTT · ESP32 OFF';
  }

  return 'MQTT · ESP32 tersambung';
}


/* =====================================================================
 *  MQTT UI
 * ===================================================================== */

function updateMqttIndicator() {
  /*
   * Jangan mengubah status server menjadi MQTT.
   * MQTT hanya ditambahkan sebagai informasi tambahan.
   */

  if (!el.netBadge || !el.netText) {
    return;
  }

  if (
    NET.mode === 'server' &&
    NET.online
  ) {
    let text =
      'Server · ' +
      NET.clients +
      ' perangkat';

    if (MQTT.connected) {
      text += ' · MQTT';

      if (MQTT.espStatus) {
        text +=
          ' · ESP32 ' +
          MQTT.espStatus;
      }
    }

    el.netBadge.setAttribute(
      'data-state',
      'server'
    );

    el.netText.textContent =
      text;

    return;
  }

  if (MQTT.connected) {
    el.netBadge.setAttribute(
      'data-state',
      'server'
    );

    el.netText.textContent =
      mqttStatusText();

    return;
  }

  if (NET.mode === 'server') {
    el.netBadge.setAttribute(
      'data-state',
      'idle'
    );

    el.netText.textContent =
      'Menghubungi server…';

    return;
  }

  el.netBadge.setAttribute(
    'data-state',
    'local'
  );

  el.netText.textContent =
    'Mode lokal (mandiri)';
}


/* =====================================================================
 *  MQTT MESSAGE
 * ===================================================================== */

function handleMqttMessage(
  topic,
  payload
) {
  const message =
    String(payload || '')
      .trim();

  MQTT.lastMessageAt =
    Date.now();

  console.log(
    '[MQTT]',
    topic,
    message
  );


  /* ---------------------------------------------------------------
   * AC STATUS
   * --------------------------------------------------------------- */

  if (
    topic ===
    MQTT_CONFIG.topics.status
  ) {
    const value =
      message.toUpperCase();

    if (
      value === 'ON' ||
      value === 'OFF'
    ) {
      MQTT.lastStatus =
        value;

      MQTT.espStatus =
        value;

      /*
       * Tidak mengubah S.power secara langsung.
       * State utama tetap berasal dari server.
       */

      updateMqttIndicator();
    }

    return;
  }


  /* ---------------------------------------------------------------
   * TEMPERATURE
   * --------------------------------------------------------------- */

  if (
    topic ===
    MQTT_CONFIG.topics.temperature
  ) {
    const value =
      parseFloat(message);

    if (
      Number.isFinite(value)
    ) {
      MQTT.lastTemperature =
        value;

      S.esp32Temperature =
        value;

      if (NET.mode === 'server') {
        render();
      }
    }

    return;
  }


  /* ---------------------------------------------------------------
   * TARGET
   * --------------------------------------------------------------- */

  if (
    topic ===
    MQTT_CONFIG.topics.target
  ) {
    const value =
      parseFloat(message);

    if (
      Number.isFinite(value)
    ) {
      MQTT.lastTarget =
        value;
    }

    return;
  }


  /* ---------------------------------------------------------------
   * MODE
   * --------------------------------------------------------------- */

  if (
    topic ===
    MQTT_CONFIG.topics.mode
  ) {
    const value =
      message.toUpperCase();

    MQTT.lastMode =
      value;

    return;
  }

  if (
    topic ===
    MQTT_CONFIG.topics.fan
  ) {
    const value = 
      message.toUpperCase().trim();

  if (value) {
    S.fan = value;

    if (NET.mode === 'server') {
      render();
    }
  }

    return;
  }
}


/* =====================================================================
 *  MQTT CONNECT
 * ===================================================================== */

async function connectMqtt() {
  if (MQTT.initialized) {
    return;
  }

  MQTT.initialized = true;

  try {
    await loadMqttLibrary();

    const url =
      tentukanMqttUrl();

    console.log(
      '[MQTT] Menghubungkan ke:',
      url
    );

    MQTT.connecting = true;
    MQTT.error = '';

    /*
     * MQTT.js client.
     *
     * Browser -> EMQX Cloud
     * WebSocket Secure / TLS
     */

    MQTT.client =
      window.mqtt.connect(
        url,
        {
          clientId:
            'ac-web-' +
            Math.random()
              .toString(16)
              .slice(2),

          username:
            MQTT_CONFIG.username,

          password:
            MQTT_CONFIG.password,

          clean: true,

          reconnectPeriod:
            MQTT_CONFIG.reconnectPeriod,

          connectTimeout:
            MQTT_CONFIG.connectTimeout,

          keepalive: 30,

          protocolVersion: 4
        }
      );


    /* ---------------------------------------------------------------
     * CONNECT
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'connect',
      () => {

        MQTT.connected = true;
        MQTT.connecting = false;
        MQTT.error = '';
        MQTT.reconnectCount++;

        console.log(
          '[MQTT] TERHUBUNG:',
          url
        );

        const topics = [
          MQTT_CONFIG.topics.status,
          MQTT_CONFIG.topics.temperature,
          MQTT_CONFIG.topics.target,
          MQTT_CONFIG.topics.mode,
          MQTT_CONFIG.topics.fan
        ];

        MQTT.client.subscribe(
          topics,
          {
            qos: 0
          },
          err => {

            if (err) {
              console.error(
                '[MQTT] Subscribe gagal:',
                err
              );

              toast(
                'MQTT tersambung, tetapi subscribe gagal',
                'warn'
              );

              return;
            }

            console.log(
              '[MQTT] Subscribe berhasil:',
              topics
            );

            toast(
              'MQTT ESP32 tersambung',
              'good'
            );

            updateMqttIndicator();
          }
        );
      }
    );


    /* ---------------------------------------------------------------
     * MESSAGE
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'message',
      (
        topic,
        payload
      ) => {
        handleMqttMessage(
          topic,
          payload
        );
      }
    );


    /* ---------------------------------------------------------------
     * RECONNECT
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'reconnect',
      () => {
        MQTT.connected = false;
        MQTT.connecting = true;

        console.log(
          '[MQTT] Mencoba reconnect...'
        );

        updateMqttIndicator();
      }
    );


    /* ---------------------------------------------------------------
     * CLOSE
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'close',
      () => {
        MQTT.connected = false;
        MQTT.connecting = false;

        console.log(
          '[MQTT] Koneksi ditutup'
        );

        updateMqttIndicator();
      }
    );


    /* ---------------------------------------------------------------
     * ERROR
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'error',
      err => {

        MQTT.connected = false;
        MQTT.connecting = false;

        MQTT.error =
          err && err.message
            ? err.message
            : 'MQTT error';

        console.warn(
          '[MQTT] Error:',
          err
        );

        updateMqttIndicator();
      }
    );


    /* ---------------------------------------------------------------
     * OFFLINE
     * --------------------------------------------------------------- */

    MQTT.client.on(
      'offline',
      () => {

        MQTT.connected = false;
        MQTT.connecting = true;

        console.log(
          '[MQTT] Offline'
        );

        updateMqttIndicator();
      }
    );


  } catch (err) {

    MQTT.initialized = false;
    MQTT.connected = false;
    MQTT.connecting = false;

    MQTT.error =
      err && err.message
        ? err.message
        : 'Gagal memuat MQTT';

    console.warn(
      '[MQTT] Tidak tersedia:',
      err
    );

    updateMqttIndicator();
  }
}


/* =====================================================================
 *  MODEL FISIKA
 * ===================================================================== */

function effectiveSet() {
  return (
    S.setTemp +
    (
      S.sleep &&
      S.sleepElapsed >
      SLEEP_DELAY
        ? 1
        : 0
    )
  );
}


function autoDirection() {
  const set =
    effectiveSet();

  if (
    S.room >
    set + 0.3
  ) {
    return 'COOL';
  }

  if (
    S.room <
    set - 0.3
  ) {
    return 'HEAT';
  }

  return null;
}


function updateCompressor() {
  if (
    !S.power ||
    S.mode === 'FAN'
  ) {
    S.compressor = false;

    return;
  }

  const set =
    effectiveSet();

  const dir =
    S.mode === 'AUTO'
      ? autoDirection()
      : S.mode;


  if (dir === 'HEAT') {

    if (
      S.room <
      set - HYST
    ) {
      S.compressor = true;
    } else if (
      S.room >
      set + HYST
    ) {
      S.compressor = false;
    }

    return;
  }


  if (dir === 'DRY') {

    if (
      S.room >
      set + 0.2
    ) {
      S.compressor = true;
    } else if (
      S.room <
      set - 0.6
    ) {
      S.compressor = false;
    }

    return;
  }


  if (dir === 'COOL') {

    if (
      S.room >
      set + HYST
    ) {
      S.compressor = true;
    } else if (
      S.room <
      set - HYST
    ) {
      S.compressor = false;
    }
  }
}


function computePower() {
  if (!S.power) {
    return 2;
  }

  let p =
    25 +
    (
      FAN_WATT[S.fan] ||
      35
    );

  if (S.compressor) {

    p +=
      MODE_WATT[S.mode] ||
      0;

    if (S.turbo) {
      p *= 1.18;
    }
  }

  return Math.round(p);
}


function physics(dt) {
  updateCompressor();

  const set =
    effectiveSet();

  const wasComp =
    S.compressor;

  let k;
  let target;


  if (!S.power) {

    k = 0.0035;
    target = S.outdoor;

  } else if (
    S.mode === 'FAN'
  ) {

    k = 0.0030;
    target = S.outdoor;

  } else if (
    S.compressor
  ) {

    const dir =
      S.mode === 'AUTO'
        ? (
            autoDirection() ||
            'COOL'
          )
        : S.mode;

    target = set;

    k =
      (
        MODE_K[dir] ||
        0.02
      ) *
      (
        FAN_FACTOR[S.fan] ||
        1
      ) *
      (
        S.turbo
          ? 1.7
          : 1
      );

  } else {

    k = 0.0025;
    target = S.outdoor;
  }


  const alpha =
    1 -
    Math.exp(
      -k * dt
    );

  S.room +=
    (
      target -
      S.room
    ) *
    alpha;

  S.room +=
    (
      Math.random() -
      0.5
    ) *
    0.004;

  S.room =
    clamp(
      S.room,
      ROOM_MIN,
      ROOM_MAX
    );


  /* kelembapan */

  let hTarget =
    S.outdoorHum;

  let hK =
    0.0022;

  if (
    S.power &&
    S.compressor &&
    S.mode !== 'FAN' &&
    S.mode !== 'HEAT'
  ) {

    hTarget =
      S.mode === 'DRY'
        ? 45
        : 52;

    hK =
      S.mode === 'DRY'
        ? 0.020
        : 0.008;
  }

  S.hum +=
    (
      hTarget -
      S.hum
    ) *
    (
      1 -
      Math.exp(
        -hK * dt
      )
    );

  S.hum +=
    (
      Math.random() -
      0.5
    ) *
    0.01;

  S.hum =
    clamp(
      S.hum,
      25,
      95
    );


  /* energi */

  S.powerW =
    computePower();

  S.energyKwh +=
    S.powerW *
    dt /
    3600 /
    1000;

  S.cost =
    S.energyKwh *
    S.tariff;


  /* log compressor */

  if (
    wasComp !==
    S.compressor
  ) {

    if (S.compressor) {

      logEvent(
        'Kompresor mulai mendinginkan (target ' +
        set.toFixed(1) +
        ' °C)',
        'on'
      );

    } else {

      logEvent(
        'Kompresor berhenti — target tercapai',
        'warn'
      );
    }
  }
}


function pushSample() {
  S.hist.push({
    room: S.room,
    set: effectiveSet(),
    comp: S.compressor
  });

  while (
    S.hist.length >
    HIST_MAX
  ) {
    S.hist.shift();
  }
}


function advance(dtSim) {
  let left =
    Math.max(
      0,
      dtSim
    );

  let guard = 0;

  while (
    left > 0 &&
    guard++ < 20000
  ) {

    const dt =
      Math.min(
        2,
        left
      );

    left -= dt;

    physics(dt);

    S.simTime += dt;

    S.duration += dt;


    if (
      S.power &&
      S.sleep
    ) {
      S.sleepElapsed += dt;
    }


    if (
      S.power &&
      S.timerRemaining > 0
    ) {

      S.timerRemaining -= dt;

      if (
        S.timerRemaining <= 0
      ) {

        S.timerRemaining = 0;

        setPower(
          false,
          'Timer selesai — AC dimatikan otomatis'
        );
      }
    }


    S.histAcc += dt;

    if (
      S.histAcc >=
      HIST_STEP
    ) {

      S.histAcc -=
        HIST_STEP;

      pushSample();
    }
  }
}


/* =====================================================================
 *  AKSI AC
 * ===================================================================== */

function setPower(on, reason) {
  if (
    S.power === on
  ) {
    return;
  }

  S.power = on;

  if (on) {

    S.sleepElapsed = 0;

    S.baseline =
      S.room;

    if (
      S.timerIdx > 0
    ) {
      S.timerRemaining =
        TIMER_STEPS[
          S.timerIdx
        ] * 60;
    }

    logEvent(
      'AC dinyalakan — ' +
      MODE_LABEL[S.mode] +
      ' ' +
      S.setTemp.toFixed(1) +
      ' °C, kipas ' +
      FAN_LABEL[S.fan],
      'on'
    );

    toast(
      'AC dinyalakan' +
      (
        reason
          ? ' — ' + reason
          : ''
      ),
      'good'
    );

  } else {

    S.compressor = false;

    S.timerRemaining = 0;

    logEvent(
      'AC dimatikan' +
      (
        reason
          ? ' — ' + reason
          : ''
      ),
      'off'
    );

    toast(
      'AC dimatikan' +
      (
        reason
          ? ' — ' + reason
          : ''
      ),
      'warn'
    );
  }

  pushSample();
}


function bumpTemp(delta) {
  const next =
    clamp(
      S.setTemp + delta,
      TEMP_MIN,
      TEMP_MAX
    );

  if (
    next ===
    S.setTemp
  ) {

    toast(
      'Batas suhu ' +
      TEMP_MIN +
      '–' +
      TEMP_MAX +
      ' °C',
      'warn'
    );

    return;
  }

  S.setTemp = next;

  S.sleepElapsed = 0;

  S.baseline =
    S.room;

  logEvent(
    'Set point diubah ke ' +
    next.toFixed(1) +
    ' °C',
    'info'
  );
}


function cycleMode() {
  const i =
    MODE_ORDER.indexOf(
      S.mode
    );

  S.mode =
    MODE_ORDER[
      (i + 1) %
      MODE_ORDER.length
    ];

  S.sleepElapsed = 0;

  S.baseline =
    S.room;

  logEvent(
    'Mode diubah ke ' +
    MODE_LABEL[S.mode],
    'info'
  );

  toast(
    'Mode: ' +
    MODE_LABEL[S.mode]
  );
}


function cycleFan() {
  const i =
    FAN_ORDER.indexOf(
      S.fan
    );

  S.fan =
    FAN_ORDER[
      (i + 1) %
      FAN_ORDER.length
    ];

  logEvent(
    'Kecepatan kipas: ' +
    FAN_LABEL[S.fan],
    'info'
  );

  toast(
    'Kipas: ' +
    FAN_LABEL[S.fan]
  );
}


function toggleSwing() {
  S.swing =
    !S.swing;

  logEvent(
    'Swing ' +
    (
      S.swing
        ? 'diaktifkan'
        : 'dimatikan'
    ),
    'info'
  );
}


function toggleTurbo() {
  S.turbo =
    !S.turbo;

  if (
    S.turbo &&
    !S.power
  ) {
    toast(
      'TURBO menunggu AC dinyalakan',
      'warn'
    );
  }

  logEvent(
    'TURBO ' +
    (
      S.turbo
        ? 'aktif — pendinginan dipercepat'
        : 'dimatikan'
    ),
    'info'
  );
}


function toggleSleep() {
  S.sleep =
    !S.sleep;

  S.sleepElapsed = 0;

  logEvent(
    'SLEEP ' +
    (
      S.sleep
        ? 'aktif — set point naik 1 °C setelah 1 jam'
        : 'dimatikan'
    ),
    'info'
  );
}


function cycleTimer() {
  S.timerIdx =
    (
      S.timerIdx + 1
    ) %
    TIMER_STEPS.length;

  const menit =
    TIMER_STEPS[
      S.timerIdx
    ];

  if (menit === 0) {

    S.timerRemaining = 0;

    logEvent(
      'Timer dimatikan',
      'info'
    );

    toast(
      'Timer: OFF'
    );

  } else {

    S.timerRemaining =
      menit * 60;

    const txt =
      menit >= 60
        ? (
            menit / 60
          ) +
          ' jam'
        : menit +
          ' menit';

    logEvent(
      'Timer mati otomatis dipasang: ' +
      txt,
      'info'
    );

    toast(
      'Timer: ' +
      txt
    );
  }
}


function resetAll(silent) {
  S.power = false;

  S.setTemp = 24;

  S.mode = 'COOL';

  S.fan = 'AUTO';

  S.swing = false;

  S.turbo = false;

  S.sleep = false;

  S.sleepElapsed = 0;

  S.timerIdx = 0;

  S.timerRemaining = 0;

  S.room = 30.4;

  S.hum = 66;

  S.compressor = false;

  S.powerW = 2;

  S.energyKwh = 0;

  S.cost = 0;

  S.simTime = SIM_START;

  S.duration = 0;

  S.hist = [];

  S.histAcc = HIST_STEP;

  S.baseline =
    S.room;

  pushSample();

  if (!silent) {

    logEvent(
      'Simulasi direset ke kondisi awal',
      'warn'
    );

    toast(
      'Simulasi direset',
      'warn'
    );
  }
}


/* =====================================================================
 *  GRAFIK
 * ===================================================================== */

function drawChart() {
  const c =
    el.chart;

  if (!c) {
    return;
  }

  const dpr =
    window.devicePixelRatio ||
    1;

  const w =
    c.clientWidth;

  const h =
    c.clientHeight;

  if (
    w < 10 ||
    h < 10
  ) {
    return;
  }

  if (
    c.width !==
      Math.round(
        w * dpr
      ) ||
    c.height !==
      Math.round(
        h * dpr
      )
  ) {

    c.width =
      Math.round(
        w * dpr
      );

    c.height =
      Math.round(
        h * dpr
      );
  }

  const g =
    c.getContext('2d');

  g.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  g.clearRect(
    0,
    0,
    w,
    h
  );


  const padL = 42;
  const padR = 14;
  const padT = 14;
  const padB = 26;

  const plotW =
    Math.max(
      10,
      w -
      padL -
      padR
    );

  const plotH =
    Math.max(
      10,
      h -
      padT -
      padB
    );


  const hist =
    S.hist;

  const setNow =
    effectiveSet();


  let mn =
    Math.min(
      S.room,
      setNow
    );

  let mx =
    Math.max(
      S.room,
      setNow
    );


  for (
    const s of hist
  ) {

    mn =
      Math.min(
        mn,
        s.room,
        s.set
      );

    mx =
      Math.max(
        mx,
        s.room,
        s.set
      );
  }


  let lo =
    Math.floor(
      mn - 1
    );

  let hi =
    Math.ceil(
      mx + 1
    );


  if (
    hi - lo < 8
  ) {

    const mid =
      (
        hi +
        lo
      ) / 2;

    lo =
      Math.floor(
        mid - 4
      );

    hi =
      Math.ceil(
        mid + 4
      );
  }


  const yOf =
    v =>
      padT +
      (
        hi - v
      ) /
      (
        hi - lo
      ) *
      plotH;


  const n =
    hist.length;


  const WINDOW_MAX =
    HIST_MAX *
    HIST_STEP;

  const spanSec =
    Math.max(
      0,
      (
        n - 1
      ) *
      HIST_STEP
    );

  const W =
    Math.max(
      60,
      Math.min(
        WINDOW_MAX,
        spanSec
      )
    );


  const xOf =
    i =>
      padL +
      plotW *
      (
        1 -
        (
          (
            n - 1 -
            i
          ) *
          HIST_STEP
        ) /
        W
      );


  /* grid Y */

  const stepY =
    (
      hi - lo
    ) <= 10
      ? 2
      : 5;

  g.font =
    '11px "Segoe UI", system-ui, sans-serif';

  g.textAlign =
    'right';

  g.textBaseline =
    'middle';


  for (
    let v = lo;
    v <= hi;
    v += stepY
  ) {

    const y =
      yOf(v);

    g.strokeStyle =
      'rgba(255,255,255,.055)';

    g.lineWidth = 1;

    g.beginPath();

    g.moveTo(
      padL,
      Math.round(y) +
        .5
    );

    g.lineTo(
      padL +
        plotW,
      Math.round(y) +
        .5
    );

    g.stroke();

    g.fillStyle =
      '#6b7d9e';

    g.fillText(
      v + '°',
      padL - 8,
      y
    );
  }


  /* grid waktu */

  let tStep = 0;

  for (
    const s of [
      30,
      60,
      120,
      300,
      600
    ]
  ) {

    const jumlah =
      W / s;

    if (
      jumlah >= 1.5 &&
      jumlah <= 7
    ) {

      tStep = s;

      break;
    }
  }


  g.textAlign =
    'center';

  g.textBaseline =
    'top';


  if (tStep > 0) {

    for (
      let off = tStep;
      off <= W + 1;
      off += tStep
    ) {

      const x =
        padL +
        plotW *
        (
          1 -
          off / W
        );

      if (
        x <
          padL + 14 ||
        x >
          padL +
          plotW -
          22
      ) {
        continue;
      }

      g.strokeStyle =
        'rgba(255,255,255,.05)';

      g.beginPath();

      g.moveTo(
        Math.round(x) +
          .5,
        padT
      );

      g.lineTo(
        Math.round(x) +
          .5,
        padT +
          plotH
      );

      g.stroke();

      g.fillStyle =
        '#55668a';

      g.fillText(
        off >= 60
          ? '-' +
            (
              off / 60
            ) +
            'm'
          : '-' +
            off +
            's',
        x,
        padT +
          plotH +
          7
      );
    }
  }


  g.fillStyle =
    '#55668a';

  g.fillText(
    'sekarang',
    padL +
      plotW,
    padT +
      plotH +
      7
  );


  if (n < 2) {

    g.fillStyle =
      '#55668a';

    g.textAlign =
      'center';

    g.textBaseline =
      'middle';

    g.fillText(
      'Menunggu data…',
      padL +
        plotW / 2,
      padT +
        plotH / 2
    );

    return;
  }


  /* pita compressor */

  g.fillStyle =
    'rgba(255,180,84,.6)';

  for (
    let i = 0;
    i < n;
    i++
  ) {

    if (
      hist[i].comp
    ) {

      const x =
        xOf(i);

      g.fillRect(
        x - 1.6,
        padT +
          plotH +
          3,
        3.2,
        6
      );
    }
  }


  /* area suhu */

  const grad =
    g.createLinearGradient(
      0,
      padT,
      0,
      padT +
        plotH
    );

  grad.addColorStop(
    0,
    'rgba(56,232,200,.30)'
  );

  grad.addColorStop(
    1,
    'rgba(56,232,200,0)'
  );


  g.beginPath();

  g.moveTo(
    xOf(0),
    padT +
      plotH
  );

  for (
    let i = 0;
    i < n;
    i++
  ) {

    g.lineTo(
      xOf(i),
      yOf(
        hist[i].room
      )
    );
  }

  g.lineTo(
    xOf(n - 1),
    padT +
      plotH
  );

  g.closePath();

  g.fillStyle =
    grad;

  g.fill();


  /* garis suhu */

  g.beginPath();

  for (
    let i = 0;
    i < n;
    i++
  ) {

    const x =
      xOf(i);

    const y =
      yOf(
        hist[i].room
      );

    if (i === 0) {
      g.moveTo(
        x,
        y
      );
    } else {
      g.lineTo(
        x,
        y
      );
    }
  }

  g.strokeStyle =
    '#38e8c8';

  g.lineWidth = 2.2;

  g.lineJoin =
    'round';

  g.shadowColor =
    'rgba(56,232,200,.55)';

  g.shadowBlur = 10;

  g.stroke();

  g.shadowBlur = 0;


  /* garis set point */

  g.beginPath();

  for (
    let i = 0;
    i < n;
    i++
  ) {

    const x =
      xOf(i);

    const y =
      yOf(
        hist[i].set
      );

    if (i === 0) {
      g.moveTo(
        x,
        y
      );
    } else {
      g.lineTo(
        x,
        y
      );
    }
  }

  g.setLineDash([
    6,
    5
  ]);

  g.strokeStyle =
    'rgba(255,180,84,.85)';

  g.lineWidth = 1.6;

  g.stroke();

  g.setLineDash([]);


  /* nilai terakhir */

  const lx =
    xOf(n - 1);

  const ly =
    yOf(
      hist[n - 1].room
    );


  g.beginPath();

  g.arc(
    lx,
    ly,
    4,
    0,
    Math.PI * 2
  );

  g.fillStyle =
    '#38e8c8';

  g.fill();

  g.strokeStyle =
    '#0a1020';

  g.lineWidth = 2;

  g.stroke();


  g.font =
    'bold 11px "Segoe UI", system-ui, sans-serif';

  g.textAlign =
    'right';

  g.textBaseline =
    'bottom';

  g.fillStyle =
    '#c6fff2';

  g.fillText(
    hist[n - 1]
      .room
      .toFixed(1) +
      ' °C',
    lx - 8,
    ly - 6
  );
}


/* =====================================================================
 *  TREND
 * ===================================================================== */

function trendInfo() {
  const h =
    S.hist;

  if (
    h.length < 4
  ) {
    return {
      text: 'Stabil',
      cls: '',
      state:
        S.power
          ? 'fan'
          : 'off'
    };
  }

  const back =
    h[
      Math.max(
        0,
        h.length - 8
      )
    ];

  const d =
    S.room -
    back.room;


  if (!S.power) {
    return {
      text: 'Menghangat',
      cls: 'is-hot',
      state: 'heating'
    };
  }


  if (
    d < -0.05
  ) {
    return {
      text: 'Mendingin',
      cls: 'is-cold',
      state: 'cooling'
    };
  }


  if (
    d > 0.05
  ) {
    return {
      text: 'Menghangat',
      cls: 'is-hot',
      state: 'heating'
    };
  }


  return {
    text: 'Stabil',
    cls: 'is-on',
    state: 'stable'
  };
}  

function suhuRealtime() {
  if (
    NET.mode === 'server' &&
    Number.isFinite(
      S.esp32Temperature
    )
  ) {
    return S.esp32Temperature;
  }

  return S.room;  
}


/* =====================================================================
 *  RENDER
 * ===================================================================== */

function render() {
  const set =
    effectiveSet();


  /* header */

  if (el.clock) {
    el.clock.textContent =
      waktuNyataText();
  }


  let badgeState =
    'off';

  let badgeText =
    'AC MATI';


  if (S.power) {

    if (S.compressor) {

      badgeState =
        'on';

      badgeText =
        'AC MENYALA · ' +
        MODE_LABEL[S.mode];

    } else {

      badgeState =
        'idle';

      badgeText =
        'AC SIAGA · ' +
        MODE_LABEL[S.mode];
    }
  }


  if (
    el.statusBadge.getAttribute(
      'data-state'
    ) !== badgeState
  ) {

    el.statusBadge.setAttribute(
      'data-state',
      badgeState
    );
  }


  el.statusText.textContent =
    badgeText;


  el.btnPowerMain.classList.toggle(
    'is-on',
    S.power
  );

  el.btnPowerLabel.textContent =
    S.power
      ? 'Matikan AC'
      : 'Nyalakan AC';


  el.btnPause.textContent =
    S.running
      ? '⏸ Jeda simulasi'
      : '▶ Lanjutkan simulasi';


  /* ---------------------------------------------------------------
   * NETWORK + MQTT
   * --------------------------------------------------------------- */

  updateMqttIndicator();


  /* server banner */

  if (el.netBanner) {

    const perlu =
      NET.mode === 'local' &&
      !NET.online &&
      !!NET.alamatDicoba &&
      !NET.bannerTutup;


    if (
      el.netBanner.hidden === perlu
    ) {
      el.netBanner.hidden =
        !perlu;
    }


    if (
      perlu &&
      NET.bannerAlamat !==
        NET.alamatDicoba
    ) {

      NET.bannerAlamat =
        NET.alamatDicoba;

      const alamat =
        NET.alamatDicoba
          .replace(
            /^https?:\/\//,
            ''
          );


      el.nbTitle.textContent =
        'PERINGATAN: ' +
        'SERVER OFFLINE / MODE LOKAL';


      el.nbDesc.textContent =
        'WEBSITE BERJALAN DALAM MODE LOKAL. ' +
        'PERUBAHAN HANYA BERLAKU DI PERANGKAT INI DAN ' +
        'TIDAK DIKIRIM KE SERVER ATAU ESP32. ' +
        'JALANKAN SERVER DI PC UNTUK KEMBALI KE MODE SERVER.';


      el.nbInput.value =
        alamat;
    }
  }


  /* angka utama */

  const suhuAktual =
    suhuRealtime();

  el.roomTemp.textContent =
    suhuAktual.toFixed(1);


  const diff =
    suhuAktual -
    set;


  el.roomSub.innerHTML =
    'Target ' +
    set.toFixed(1) +
    ' °C &middot; selisih ' +
    (
      diff >= 0
        ? '+'
        : '−'
    ) +
    Math.abs(
      diff
    ).toFixed(1) +
    ' °C';


  const tr =
    trendInfo();


  el.chipTrend.textContent =
    tr.text;

  el.chipTrend.className =
    'chip chip-live ' +
    tr.cls;


  let stateText;
  let stateKind;


  if (!S.power) {

    stateText =
      'AC dalam keadaan mati — ruangan menuju suhu luar';

    stateKind =
      'off';

  } else if (
    S.mode === 'FAN'
  ) {

    stateText =
      'Mode FAN — hanya sirkulasi udara, tanpa pendinginan';

    stateKind =
      'fan';

  } else if (
    S.compressor
  ) {

    const arah =
      (
        S.mode === 'HEAT' ||
        (
          S.mode === 'AUTO' &&
          autoDirection() ===
            'HEAT'
        )
      )
        ? 'Memanaskan'
        : 'Mendinginkan';


    stateText =
      arah +
      ' menuju ' +
      set.toFixed(1) +
      ' °C' +
      (
        S.turbo
          ? ' · TURBO aktif'
          : ''
      );


    stateKind =
      arah === 'Memanaskan'
        ? 'heating'
        : 'cooling';

  } else {

    stateText =
      'Target tercapai — kompresor beristirahat';

    stateKind =
      'stable';
  }


  if (
    el.roomState.getAttribute(
      'data-state'
    ) !== stateKind
  ) {

    el.roomState.setAttribute(
      'data-state',
      stateKind
    );
  }


  el.roomState.textContent =
    stateText;


  el.chipComp.textContent =
    'Kompresor: ' +
    (
      S.compressor
        ? 'MENYALA'
        : 'MATI'
    );


  el.chipComp.className =
    'chip' +
    (
      S.compressor
        ? ' is-on'
        : ''
    );


  /* statistik */

  el.stSet.textContent =
    set.toFixed(1) +
    ' °C' +
    (
      S.sleep &&
      S.sleepElapsed >
        SLEEP_DELAY
        ? ' (sleep)'
        : ''
    );


  el.stOut.textContent =
    S.outdoor.toFixed(1) +
    ' °C';


  el.stHum.textContent =
    S.hum.toFixed(0) +
    ' %';


  el.stPower.textContent =
    S.powerW >= 100
      ? S.powerW +
        ' W'
      : S.powerW.toFixed(1) +
        ' W';


  el.stEnergy.textContent =
    S.energyKwh.toFixed(3) +
    ' kWh';


  el.stCost.textContent =
    rupiah(
      S.cost
    );


  /* progress */

  const span0 =
    Math.max(
      0.6,
      Math.abs(
        S.baseline -
        set
      )
    );


  const prog =
    clamp(
      100 -
      (
        Math.abs(
          diff
        ) /
        span0
      ) *
      100,
      0,
      100
    );


  el.barProg.style.width =
    prog.toFixed(1) +
    '%';

  el.barProgVal.textContent =
    prog.toFixed(0) +
    '%';


  const maxW =
    1400;


  el.barPower.style.width =
    clamp(
      S.powerW /
        maxW *
        100,
      0,
      100
    ).toFixed(1) +
    '%';


  el.barPowerVal.textContent =
    S.powerW +
    ' W';


  el.barHum.style.width =
    clamp(
      (
        S.hum - 20
      ) /
      70 *
      100,
      0,
      100
    ).toFixed(1) +
    '%';


  el.barHumVal.textContent =
    S.hum.toFixed(0) +
    ' %';


  /* remote */

  el.rsPower.textContent =
    S.power
      ? 'ON'
      : 'OFF';


  el.rsPower.className =
    'rs-power ' +
    (
      S.power
        ? 'on'
        : 'off'
    );


  el.rsClock.textContent =
    waktuNyataText();


  el.rsTempBox.classList.toggle(
    'blank',
    !S.power
  );


  el.rsTemp.textContent =
    S.power
      ? String(
          S.setTemp
        )
      : '--';


  el.rsMode.textContent =
    MODE_ICON[S.mode] +
    ' ' +
    MODE_LABEL[S.mode];


  el.rsFan.textContent =
    'FAN ' +
    FAN_LABEL[S.fan];


  el.rsSwing.textContent =
    'SWING ' +
    (
      S.swing
        ? 'ON'
        : 'OFF'
    );


  el.rsTimer.textContent =
    S.power &&
    S.timerRemaining > 0
      ? '⏱ ' +
        fmtDur(
          S.timerRemaining
        )
      : 'TIMER ' +
        TIMER_TEXT[
          TIMER_STEPS[
            S.timerIdx
          ]
        ];


  el.rsTurbo.className =
    'flag' +
    (
      S.turbo
        ? ' on'
        : ''
    );


  el.rsSleep.className =
    'flag' +
    (
      S.sleep
        ? ' on'
        : ''
    );


  el.chipRemote.textContent =
    S.power
      ? (
          S.compressor
            ? 'Pendinginan aktif'
            : 'Siaga'
        )
      : 'Remote siaga';


  /* unit AC */

  el.acIndoor.classList.toggle(
    'is-on',
    S.power
  );


  el.acIndoor.classList.toggle(
    'swing',
    S.swing &&
    S.power
  );


  el.outFan.classList.toggle(
    'spin',
    S.compressor
  );


  el.indoorDisplay.textContent =
    S.power
      ? String(
          S.setTemp
        )
      : '--';


  el.chipUnit.textContent =
    S.power
      ? (
          S.compressor
            ? 'Bekerja'
            : 'Standby'
        )
      : 'Mati';


  el.chipUnit.className =
    'chip' +
    (
      S.power
        ? (
            S.compressor
              ? ' is-on'
              : ' is-hot'
          )
        : ''
    );


  el.umStatus.textContent =
    S.power
      ? 'Menyala'
      : 'Mati';


  el.umComp.textContent =
    S.compressor
      ? 'ON — ' +
        Math.round(
          S.powerW
        ) +
        ' W'
      : 'OFF';


  el.umMode.textContent =
    MODE_LABEL[S.mode];


  el.umFan.textContent =
    FAN_LABEL[S.fan] +
    (
      S.turbo
        ? ' + TURBO'
        : ''
    );


  el.umSwing.textContent =
    S.swing
      ? (
          S.power
            ? 'Berayun'
            : 'Aktif (menunggu)'
        )
      : 'Nonaktif';


  el.umTimer.textContent =
    S.power &&
    S.timerRemaining > 0
      ? 'Sisa ' +
        fmtDur(
          S.timerRemaining
        )
      : (
          TIMER_STEPS[
            S.timerIdx
          ] > 0
            ? 'Menunggu dinyalakan'
            : 'Tidak aktif'
        );


  /* tombol remote */

  for (
    const b of remoteButtons
  ) {

    const a =
      b.dataset.act;

    let on = false;


    if (
      a === 'power'
    ) {
      on = S.power;

    } else if (
      a === 'swing'
    ) {
      on = S.swing;

    } else if (
      a === 'turbo'
    ) {
      on = S.turbo;

    } else if (
      a === 'sleep'
    ) {
      on = S.sleep;

    } else if (
      a === 'timer'
    ) {
      on =
        TIMER_STEPS[
          S.timerIdx
        ] > 0;
    }


    b.classList.toggle(
      'active',
      on
    );


    if (
      a === 'power'
    ) {
      b.classList.toggle(
        'is-on',
        S.power
      );
    }
  }


  drawChart();
}


/* =====================================================================
 *  ACTIONS
 * ===================================================================== */

const ACTIONS = {

  power: () =>
    setPower(
      !S.power
    ),

  tempUp: () =>
    bumpTemp(1),

  tempDown: () =>
    bumpTemp(-1),

  mode: () =>
    cycleMode(),

  fan: () =>
    cycleFan(),

  swing: () =>
    toggleSwing(),

  turbo: () =>
    toggleTurbo(),

  sleep: () =>
    toggleSleep(),

  timer: () =>
    cycleTimer(),

  reset: () =>
    resetAll(),

  pause: () => {

    S.running =
      !S.running;

    logEvent(
      'Simulasi ' +
      (
        S.running
          ? 'dilanjutkan'
          : 'dijeda'
      ),
      'info'
    );

    toast(
      S.running
        ? 'Simulasi dilanjutkan'
        : 'Simulasi dijeda'
    );
  },

  ff: () => {

    S.running = true;

    advance(
      1800
    );

    logEvent(
      'Simulasi dimajukan 30 menit',
      'warn'
    );

    toast(
      'Waktu dimajukan 30 menit',
      'warn'
    );
  }
};


/* =====================================================================
 *  BUTTON REMOTE
 * ===================================================================== */

remoteButtons.forEach(
  btn => {

    btn.addEventListener(
      'click',
      () => {

        doAction(
          btn.dataset.act
        );
      }
    );
  }
);


el.btnPowerMain.addEventListener(
  'click',
  () =>
    doAction('power')
);


el.btnClearLog.addEventListener(
  'click',
  () => {

    if (
      NET.mode ===
      'server'
    ) {

      toast(
        'Log diisi oleh server, tidak bisa dibersihkan dari sini',
        'warn'
      );

      return;
    }

    el.logList.innerHTML =
      '<li class="log-empty">' +
      'Belum ada kejadian.' +
      '</li>';
  }
);


el.btnResetAll.addEventListener(
  'click',
  () =>
    doAction('reset')
);


/* =====================================================================
 *  SETTING
 * ===================================================================== */

el.rngOutdoor.addEventListener(
  'input',
  () => {

    S.outdoor =
      parseFloat(
        el.rngOutdoor.value
      );

    el.valOutdoor.textContent =
      S.outdoor.toFixed(1) +
      ' °C';

    pushSetting({
      outdoor:
        S.outdoor
    });
  }
);


el.rngHumOut.addEventListener(
  'input',
  () => {

    S.outdoorHum =
      parseFloat(
        el.rngHumOut.value
      );

    el.valHumOut.textContent =
      S.outdoorHum.toFixed(0) +
      ' %';

    pushSetting({
      outdoorHum:
        S.outdoorHum
    });
  }
);


el.selSpeed.addEventListener(
  'change',
  () => {

    S.speed =
      parseFloat(
        el.selSpeed.value
      );

    pushSetting({
      speed:
        S.speed
    });

    toast(
      'Kecepatan simulasi: ' +
      S.speed +
      '×'
    );

    logEvent(
      'Kecepatan simulasi diubah ke ' +
      S.speed +
      '×',
      'info'
    );
  }
);


el.inpTariff.addEventListener(
  'change',
  () => {

    const v =
      parseFloat(
        el.inpTariff.value
      );

    S.tariff =
      isFinite(v) &&
      v > 0
        ? v
        : 1444.7;

    el.inpTariff.value =
      S.tariff;

    S.cost =
      S.energyKwh *
      S.tariff;

    pushSetting({
      tariff:
        S.tariff
    });
  }
);


el.btnFF.addEventListener(
  'click',
  () =>
    doAction('ff')
);


el.btnPause.addEventListener(
  'click',
  () =>
    doAction('pause')
);


/* =====================================================================
 *  SERVER BANNER
 * ===================================================================== */

if (el.nbConnect) {

  el.nbConnect.addEventListener(
    'click',
    () =>
      sambungKe(
        el.nbInput.value
      ).then(render)
  );


  el.nbInput.addEventListener(
    'keydown',
    ev => {

      if (
        ev.key ===
        'Enter'
      ) {

        sambungKe(
          el.nbInput.value
        ).then(render);
      }
    }
  );
}


if (el.nbRetry) {

  el.nbRetry.addEventListener(
    'click',
    () => {

      toast(
        'Mencari server…'
      );

      detectServer()
        .then(render);
    }
  );
}


if (el.nbClose) {

  el.nbClose.addEventListener(
    'click',
    () => {

      NET.bannerTutup =
        true;

      render();
    }
  );
}


/* =====================================================================
 *  KEYBOARD
 * ===================================================================== */

document.addEventListener(
  'keydown',
  e => {

    if (
      e.target.matches(
        'input, select, textarea'
      )
    ) {
      return;
    }


    const k =
      e.key.toLowerCase();


    const map = {
      p: 'power',

      arrowup:
        'tempUp',

      arrowdown:
        'tempDown',

      m: 'mode',

      f: 'fan',

      s: 'swing',

      t: 'turbo',

      n: 'sleep',

      l: 'timer',

      r: 'reset'
    };


    const act =
      map[k];


    if (act) {

      e.preventDefault();

      /*
       * PENTING:
       * Sebelumnya langsung ACTIONS[act]().
       *
       * Sekarang menggunakan doAction()
       * supaya keyboard mengikuti mode
       * server/HP yang sama dengan tombol.
       */

      doAction(act);

    } else if (
      k === ' '
    ) {

      e.preventDefault();

      el.btnPause.click();
    }
  }
);


window.addEventListener(
  'resize',
  drawChart
);

/* =====================================================================
 *  JAM REALTIME
 * ===================================================================== */

function updateJamRealtime() {
  if (el.clock) {
    el.clock.textContent =
      waktuNyataText();
  }

  if (el.rsClock) {
    el.rsClock.textContent =
      waktuNyataShort();
  }
}

setInterval(
  updateJamRealtime,
  1000
);

updateJamRealtime();


/* =====================================================================
 *  MESIN LOOP
 * ===================================================================== */

let lastFrame =
  performance.now();


function loop(now) {

  const dtReal =
    Math.min(
      0.3,
      (
        now -
        lastFrame
      ) /
      1000
    );

  lastFrame =
    now;


  if (NET.mode ==='server') {

    if (
      now - NET.lastPoll >= NET.pollMs &&
      !NET.pending
    ) {
    NET.lastPoll = now;
    pollServer();
    }

  } else {
    if (S.running) {
      advance(
        dtReal * S.speed
      );
    }

    if (
      now - NET.lastRetry >= NET.retryMs &&
      !NET.pending
    ) {
      NET.lastRetry = now;
      detectServer();
    }
  }


  render();

  requestAnimationFrame(
    loop
  );
}


/* =====================================================================
 *  INIT
 * ===================================================================== */

(function init() {

  /* setting awal */

  el.rngOutdoor.value =
    S.outdoor;

  el.valOutdoor.textContent =
    S.outdoor.toFixed(1) +
    ' °C';


  el.rngHumOut.value =
    S.outdoorHum;

  el.valHumOut.textContent =
    S.outdoorHum.toFixed(0) +
    ' %';


  el.selSpeed.value =
    String(
      S.speed
    );


  el.inpTariff.value =
    S.tariff;


  /* sample awal */

  pushSample();


  /* log awal */

  logEvent(
    'Simulasi dimulai — AC dalam keadaan mati, suhu ruangan ' +
    S.room.toFixed(1) +
    ' °C',
    'info'
  );


  logEvent(
    'Tekan tombol POWER untuk menyalakan AC',
    'info'
  );


  /* ---------------------------------------------------------------
   * HASH
   * --------------------------------------------------------------- */

  const token =
    location.hash
      .replace(
        /^#/,
        ''
      )
      .toLowerCase()
      .split(
        /[,&+]/
      );


  const mauNyala =
    token.some(
      t =>
        t === 'on' ||
        t === 'nyala' ||
        t === 'demo'
    );


  if (
    token.indexOf(
      'remote'
    ) >= 0
  ) {

    document.body.classList.add(
      'view-remote'
    );
  }


  if (mauNyala) {

    setPower(
      true
    );

    logEvent(
      'Mode peragaan — AC dinyalakan otomatis',
      'on'
    );
  }


  /* render pertama */

  render();


  /* loop */

  requestAnimationFrame(
    loop
  );


  /* ---------------------------------------------------------------
   * ALAMAT SERVER
   * --------------------------------------------------------------- */

  NET.alamatBawaan =
    rapikanAlamat(
      window.AC_SERVER ||
      ''
    );


  /*
   * Cari server HTTP.
   */

  detectServer()
    .then(
      adaServer => {

        if (
          adaServer
        ) {

          if (
            mauNyala &&
            !S.power
          ) {

            doAction(
              'power'
            );
          }

        } else if (
          !NET.alamatBawaan &&
          !alamatTersimpan()
        ) {

          NET.alamatDicoba =
            '';
        }


        render();
      }
    );


  /* ---------------------------------------------------------------
   * MQTT
   * --------------------------------------------------------------- */

  /*
   * MQTT dijalankan terpisah dari HTTP server.
   *
   * Browser tetap mencoba MQTT Cloud
   * walaupun HTTP server sedang mencari
   * /api/state.
   */

  connectMqtt();


})();


/* =====================================================================
 *  DEBUG HELPER
 * ===================================================================== */

/*
 * Bisa digunakan dari Console browser:
 *
 *   MQTT.connected
 *   MQTT.espStatus
 *   MQTT.lastTemperature
 *   MQTT.lastTarget
 *   MQTT.lastMode
 *   MQTT.url
 *
 * Contoh:
 *
 *   MQTT.client.publish('ac/control', 'ON')
 *
 * JANGAN gunakan publish control dari browser pada penggunaan normal.
 * Kontrol tetap melalui server.py.
 */

window.AC_MQTT = MQTT;
window.AC_NET = NET;
window.AC_STATE = S;