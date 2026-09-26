/**
 * VoiceSync Memo - 録音×同時文字起こしスマートノート
 * Orchestrator Ver.3.5 & Speech Specialist Ver.3.1 準拠実装
 */

// ============================================================
// 1. 定数・状態管理
// ============================================================
const DB_NAME = 'VoiceSyncMemoDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

const state = {
  isRecording: false,
  startTime: null,
  timerInterval: null,
  currentSessionId: null,
  
  // 音声ストリーム・録音
  mediaStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  currentAudioBlob: null,
  currentAudioUrl: null,
  
  // Web Speech API
  recognition: null,
  speechSupported: false,
  isRecognitionActive: false,
  
  // オーディオアナライザー (音量メーター)
  audioContext: null,
  analyser: null,
  animFrameId: null,
  
  // 文字起こしデータ
  // { id, timestamp: seconds, timeStr: '00:15', text: '...', tag: 'important'|'idea'|'todo'|null }
  segments: [],
  pendingPinTag: null, // 次の発話に付与するタグ
  
  // UI設定
  autoScroll: true,
  theme: 'dark'
};

// ============================================================
// 2. DOM要素の取得
// ============================================================
const elements = {
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  browserBadge: document.getElementById('browser-support-badge'),
  
  timerDisplay: document.getElementById('timer-display'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  vuMeterBar: document.getElementById('vu-meter-bar'),
  
  recordToggleBtn: document.getElementById('record-toggle-btn'),
  recordBtnIcon: document.getElementById('record-btn-icon'),
  recordBtnText: document.getElementById('record-btn-text'),
  
  quickActions: document.getElementById('quick-actions'),
  pinButtons: document.querySelectorAll('.pin-btn'),
  
  playbackSection: document.getElementById('playback-section'),
  audioPlayer: document.getElementById('audio-player'),
  speedButtons: document.querySelectorAll('.speed-btn'),
  
  exportSection: document.getElementById('export-section'),
  downloadAudioBtn: document.getElementById('download-audio-btn'),
  downloadTextBtn: document.getElementById('download-text-btn'),
  copyTextBtn: document.getElementById('copy-text-btn'),
  
  historyList: document.getElementById('history-list'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  
  transcriptFeed: document.getElementById('transcript-feed'),
  segmentCount: document.getElementById('segment-count'),
  autoscrollCheckbox: document.getElementById('autoscroll-checkbox'),
  clearCurrentTranscriptBtn: document.getElementById('clear-current-transcript-btn'),
  
  interimPreview: document.getElementById('interim-preview'),
  interimText: document.getElementById('interim-text'),
  
  toast: document.getElementById('toast')
};

// ============================================================
// 3. 初期化 & ブラウザ互換性チェック
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  checkBrowserSupport();
  await initIndexedDB();
  loadHistoryFromDB();
  setupEventListeners();
});

function initTheme() {
  const savedTheme = localStorage.getItem('voicesync_theme') || 'dark';
  state.theme = savedTheme;
  document.documentElement.setAttribute('data-theme', savedTheme);
  elements.themeToggleBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
}

function checkBrowserSupport() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';

  if (SpeechRecognition && hasMediaDevices && hasMediaRecorder) {
    state.speechSupported = true;
    elements.browserBadge.textContent = 'Speech API / 録音対応';
    elements.browserBadge.className = 'badge success';
    initSpeechRecognition(SpeechRecognition);
  } else {
    elements.browserBadge.textContent = '一部機能が非対応';
    elements.browserBadge.className = 'badge warning';
    showToast('お使いのブラウザは音声認識または録音機能の一部に未対応です。Google Chromeを推奨します。');
  }
}

// ============================================================
// 4. Web Speech API 初期化 & ライフサイクル管理 (Speech Specialist準拠)
// ============================================================
function initSpeechRecognition(SpeechRecognitionClass) {
  const recognition = new SpeechRecognitionClass();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ja-JP';
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.isRecognitionActive = true;
  };

  recognition.onresult = (event) => {
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        // mem_001_voice_trim 準拠: トリムと整形
        const cleanText = transcript.trim();
        if (cleanText.length > 0) {
          addFinalSegment(cleanText);
        }
      } else {
        interim += transcript;
      }
    }

    // 中間認識結果の表示
    if (interim.trim().length > 0) {
      elements.interimPreview.style.display = 'flex';
      elements.interimText.textContent = interim;
      if (state.autoScroll) {
        scrollToBottom();
      }
    } else {
      elements.interimPreview.style.display = 'none';
    }
  };

  recognition.onerror = (event) => {
    console.warn('SpeechRecognition error:', event.error);
    if (event.error === 'not-allowed') {
      showToast('マイクの使用が拒否されました。ブラウザの設定で許可してください。');
      stopRecording();
    } else if (event.error === 'network') {
      showToast('音声認識のネットワーク通信で一時的なエラーが発生しました。');
    }
  };

  recognition.onend = () => {
    state.isRecognitionActive = false;
    // 録音中であれば自動再起動（無音による自動切断を防止）
    if (state.isRecording) {
      try {
        recognition.start();
      } catch (err) {
        console.warn('Recognition restart failed:', err);
      }
    } else {
      elements.interimPreview.style.display = 'none';
    }
  };

  state.recognition = recognition;
}

// ============================================================
// 5. 録音の開始・停止制御
// ============================================================
async function toggleRecording() {
  if (state.isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    // 1. マイクストリーム取得
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 2. MediaRecorder 初期化
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else {
        mimeType = '';
      }
    }

    state.recordedChunks = [];
    state.mediaRecorder = mimeType
      ? new MediaRecorder(state.mediaStream, { mimeType })
      : new MediaRecorder(state.mediaStream);

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        state.recordedChunks.push(e.data);
      }
    };

    state.mediaRecorder.onstop = handleRecordingStopped;
    state.mediaRecorder.start(250); // 250msごとにchunkを収集

    // 3. AudioContext & Analyser (音量VUメーター)
    setupAudioAnalyser(state.mediaStream);

    // 4. Web Speech API 開始
    if (state.recognition) {
      try {
        state.recognition.start();
      } catch (e) {
        console.warn('Recognition start warning:', e);
      }
    }

    // 5. 状態・UI更新
    state.isRecording = true;
    state.startTime = Date.now();
    state.currentSessionId = 'session_' + Date.now();
    state.segments = [];
    renderSegments();

    startTimer();
    updateRecordingUI(true);

    showToast('録音とリアルタイム文字起こしを開始しました');
  } catch (error) {
    console.error('Recording start failed:', error);
    if (error.name === 'NotAllowedError') {
      showToast('マイクの使用許可が必要です。');
    } else {
      showToast('マイクの初期化に失敗しました: ' + error.message);
    }
  }
}

async function stopRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;

  stopTimer();
  updateRecordingUI(false);

  // 音量メーター停止
  teardownAudioAnalyser();

  // MediaRecorder 停止
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  // マイクストリームのトラック停止（マイクLED消灯）
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }

  // Web Speech API 停止
  if (state.recognition && state.isRecognitionActive) {
    try {
      state.recognition.stop();
    } catch (e) {
      console.warn('Recognition stop error:', e);
    }
  }

  elements.interimPreview.style.display = 'none';
  showToast('録音を停止し、データをまとめました');
}

function handleRecordingStopped() {
  const mimeType = state.recordedChunks.length > 0 && state.recordedChunks[0].type
    ? state.recordedChunks[0].type
    : 'audio/webm';

  const audioBlob = new Blob(state.recordedChunks, { type: mimeType });
  state.currentAudioBlob = audioBlob;

  if (state.currentAudioUrl) {
    URL.revokeObjectURL(state.currentAudioUrl);
  }
  state.currentAudioUrl = URL.createObjectURL(audioBlob);

  // プレイヤーに音声をセット
  elements.audioPlayer.src = state.currentAudioUrl;
  elements.playbackSection.style.display = 'flex';
  elements.exportSection.style.display = 'flex';

  // データベースに自動保存
  saveCurrentSessionToDB();
}

// ============================================================
// 6. 音量メーター (Web Audio API)
// ============================================================
function setupAudioAnalyser(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    state.analyser = analyser;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function updateMeter() {
      if (!state.isRecording) return;
      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const volumePercent = Math.min(100, Math.round((average / 128) * 100));

      elements.vuMeterBar.style.width = volumePercent + '%';
      state.animFrameId = requestAnimationFrame(updateMeter);
    }

    updateMeter();
  } catch (err) {
    console.warn('AudioContext Analyser not available:', err);
  }
}

function teardownAudioAnalyser() {
  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }
  elements.vuMeterBar.style.width = '0%';
}

// ============================================================
// 7. タイマー管理
// ============================================================
function startTimer() {
  state.startTime = Date.now();
  elements.timerDisplay.textContent = '00:00:00';
  state.timerInterval = setInterval(() => {
    const elapsedMs = Date.now() - state.startTime;
    elements.timerDisplay.textContent = formatTime(elapsedMs);
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0')
  ].join(':');
}

function formatSeconds(sec) {
  const totalSec = Math.floor(sec);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================
// 8. 文字起こしセグメント管理 & DOM描画 (XSS防御 mem_004 準拠)
// ============================================================
function addFinalSegment(text) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - state.startTime) / 1000);
  
  const segment = {
    id: 'seg_' + now + '_' + Math.random().toString(36).substring(2, 6),
    timestamp: Math.round(elapsedSec * 10) / 10,
    timeStr: formatSeconds(elapsedSec),
    text: text,
    tag: state.pendingPinTag || null
  };

  // 一度使ったピンタグはリセット
  state.pendingPinTag = null;
  state.segments.push(segment);

  renderSegments();
  updateSegmentCount();

  if (state.autoScroll) {
    scrollToBottom();
  }
}

function renderSegments() {
  const feed = elements.transcriptFeed;

  // プレースホルダー管理
  if (state.segments.length === 0) {
    feed.innerHTML = `
      <div class="placeholder-message" id="feed-placeholder">
        <div class="placeholder-icon">💬</div>
        <p>「録音＆文字起こし開始」を押すと、話した言葉がここにリアルタイムで記録されます。</p>
        <p class="placeholder-sub">※ マイクのアクセスを許可してください</p>
      </div>
    `;
    return;
  }

  // mem_004_xss_prevention: DOM APIで安全に生成
  feed.innerHTML = '';

  state.segments.forEach((seg, index) => {
    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.dataset.id = seg.id;
    item.dataset.timestamp = seg.timestamp;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `${seg.timeStr} 発言を再生: ${seg.text}`);

    // タイムスタンプバッジ
    const badge = document.createElement('span');
    badge.className = 'timestamp-badge';
    badge.textContent = seg.timeStr;
    item.appendChild(badge);

    // テキスト＆タグコンテンツ
    const wrap = document.createElement('div');
    wrap.className = 'transcript-content-wrap';

    if (seg.tag) {
      const tagBadge = document.createElement('span');
      tagBadge.className = `tag-badge ${seg.tag}`;
      tagBadge.textContent = getTagLabel(seg.tag);
      wrap.appendChild(tagBadge);
    }

    const textSpan = document.createElement('p');
    textSpan.className = 'transcript-text';
    textSpan.textContent = seg.text;
    wrap.appendChild(textSpan);

    item.appendChild(wrap);

    // クリックまたはEnterキーで音声同期再生
    const playAction = () => seekAndPlay(seg.timestamp, item);
    item.addEventListener('click', playAction);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        playAction();
      }
    });

    feed.appendChild(item);
  });
}

function getTagLabel(tag) {
  switch (tag) {
    case 'important': return '⭐ 重要';
    case 'idea': return '💡 アイデア';
    case 'todo': return '✅ ToDo';
    default: return tag;
  }
}

function updateSegmentCount() {
  elements.segmentCount.textContent = `${state.segments.length} 件の発話`;
}

function scrollToBottom() {
  elements.transcriptFeed.scrollTop = elements.transcriptFeed.scrollHeight;
}

// ============================================================
// 9. 音声×文字 同期シーク再生 (コア機能)
// ============================================================
function seekAndPlay(timestamp, targetElement) {
  const audio = elements.audioPlayer;
  if (!audio.src) {
    showToast('再生可能な録音データがありません。まず録音を完了してください。');
    return;
  }

  // 指定秒数へシーク
  audio.currentTime = timestamp;
  audio.play().catch((err) => {
    console.warn('Audio play failed:', err);
  });

  // アクティブ強調表示
  document.querySelectorAll('.transcript-item').forEach((el) => el.classList.remove('playing'));
  if (targetElement) {
    targetElement.classList.add('playing');
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// 音声再生中の時間に合わせて文字ハイライトを追従
function setupAudioSync() {
  const audio = elements.audioPlayer;

  audio.addEventListener('timeupdate', () => {
    const curTime = audio.currentTime;
    if (state.segments.length === 0) return;

    // 現在時間以下で直近のセグメントを探す
    let activeSeg = null;
    for (let i = 0; i < state.segments.length; i++) {
      const seg = state.segments[i];
      const nextSeg = state.segments[i + 1];
      const nextTime = nextSeg ? nextSeg.timestamp : Infinity;

      if (curTime >= seg.timestamp && curTime < nextTime) {
        activeSeg = seg;
        break;
      }
    }

    document.querySelectorAll('.transcript-item').forEach((el) => {
      if (activeSeg && el.dataset.id === activeSeg.id) {
        el.classList.add('playing');
      } else {
        el.classList.remove('playing');
      }
    });
  });

  // 再生速度ボタンのイベント
  elements.speedButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      audio.playbackRate = speed;
      elements.speedButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ============================================================
// 10. クイックピン留め (重要 / アイデア / ToDo)
// ============================================================
function setPinTag(tagType) {
  state.pendingPinTag = tagType;
  showToast(`次の一文に「${getTagLabel(tagType)}」タグを付けます`);

  // もし既に直前のセグメントがある場合、直近のセグメントにも付与可能とする
  if (state.segments.length > 0) {
    const lastSeg = state.segments[state.segments.length - 1];
    if (!lastSeg.tag) {
      lastSeg.tag = tagType;
      renderSegments();
      saveCurrentSessionToDB();
    }
  }
}

// ============================================================
// 11. UIステート更新 (アクセシビリティ mem_002 準拠)
// ============================================================
function updateRecordingUI(isRecording) {
  if (isRecording) {
    elements.recordToggleBtn.classList.add('active');
    elements.recordBtnIcon.textContent = '⏹';
    elements.recordBtnText.textContent = '録音＆文字起こし停止';
    elements.statusDot.classList.add('recording');
    elements.statusText.textContent = '● 録音中（話しかけてください）';
    elements.quickActions.style.display = 'flex';
  } else {
    elements.recordToggleBtn.classList.remove('active');
    elements.recordBtnIcon.textContent = '⏺';
    elements.recordBtnText.textContent = '録音＆文字起こし開始';
    elements.statusDot.classList.remove('recording');
    elements.statusText.textContent = '停止中（完了）';
    elements.quickActions.style.display = 'none';
    elements.vuMeterBar.style.width = '0%';
    elements.recordToggleBtn.focus(); // mem_002_todo_focus 準拠
  }
}

// ============================================================
// 12. 永続化ストレージ (IndexedDB)
// ============================================================
let dbInstance = null;

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      console.error('IndexedDB open error:', e);
      reject(e);
    };
  });
}

async function saveCurrentSessionToDB() {
  if (!dbInstance || !state.currentAudioBlob) return;

  const sessionRecord = {
    id: state.currentSessionId || ('session_' + Date.now()),
    date: new Date().toLocaleString('ja-JP'),
    durationStr: elements.timerDisplay.textContent,
    audioBlob: state.currentAudioBlob,
    segments: state.segments
  };

  try {
    const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(sessionRecord);
    tx.oncomplete = () => {
      loadHistoryFromDB();
    };
  } catch (err) {
    console.error('Failed to save session to DB:', err);
  }
}

function loadHistoryFromDB() {
  if (!dbInstance) return;

  const tx = dbInstance.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();

  request.onsuccess = () => {
    const records = request.result || [];
    renderHistoryList(records.reverse()); // 新しい順
  };
}

function renderHistoryList(records) {
  const container = elements.historyList;
  container.innerHTML = '';

  if (records.length === 0) {
    container.innerHTML = '<p class="empty-state">保存された録音はありません</p>';
    return;
  }

  records.forEach((rec) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (rec.id === state.currentSessionId) {
      item.classList.add('active');
    }

    const info = document.createElement('div');
    info.className = 'history-item-info';

    const date = document.createElement('span');
    date.className = 'history-item-date';
    date.textContent = rec.date;

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.textContent = `⏱ ${rec.durationStr || '00:00'} / 💬 ${rec.segments ? rec.segments.length : 0}件の発話`;

    info.appendChild(date);
    info.appendChild(meta);
    item.appendChild(info);

    // 削除ボタン
    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete-btn';
    delBtn.title = '削除';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionFromDB(rec.id);
    });

    item.appendChild(delBtn);

    // クリックでセッション復元
    item.addEventListener('click', () => {
      restoreSession(rec);
    });

    container.appendChild(item);
  });
}

function restoreSession(rec) {
  state.currentSessionId = rec.id;
  state.segments = rec.segments || [];
  state.currentAudioBlob = rec.audioBlob;

  if (state.currentAudioUrl) {
    URL.revokeObjectURL(state.currentAudioUrl);
  }
  state.currentAudioUrl = URL.createObjectURL(rec.audioBlob);

  elements.audioPlayer.src = state.currentAudioUrl;
  elements.timerDisplay.textContent = rec.durationStr || '00:00:00';
  elements.playbackSection.style.display = 'flex';
  elements.exportSection.style.display = 'flex';

  renderSegments();
  updateSegmentCount();
  loadHistoryFromDB();
  showToast(`「${rec.date}」の録音を読み込みました`);
}

function deleteSessionFromDB(id) {
  if (!confirm('この録音データを削除してもよろしいですか？')) return;

  const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.delete(id);
  tx.oncomplete = () => {
    if (state.currentSessionId === id) {
      state.currentSessionId = null;
      state.segments = [];
      elements.audioPlayer.src = '';
      elements.playbackSection.style.display = 'none';
      elements.exportSection.style.display = 'none';
      renderSegments();
    }
    loadHistoryFromDB();
    showToast('セッションを削除しました');
  };
}

function clearAllHistory() {
  if (!confirm('保存済みのすべての録音データを消去しますか？（取り消せません）')) return;

  const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.clear();
  tx.oncomplete = () => {
    state.currentSessionId = null;
    state.segments = [];
    elements.audioPlayer.src = '';
    elements.playbackSection.style.display = 'none';
    elements.exportSection.style.display = 'none';
    renderSegments();
    loadHistoryFromDB();
    showToast('すべての履歴を削除しました');
  };
}

// ============================================================
// 13. エクスポート機能 (ダウンロード・コピー)
// ============================================================
function downloadAudio() {
  if (!state.currentAudioBlob) {
    showToast('ダウンロード可能な音声がありません');
    return;
  }
  const ext = state.currentAudioBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const filename = `recording_${getTimestampString()}.${ext}`;
  const a = document.createElement('a');
  a.href = state.currentAudioUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast(`音声ファイル (${filename}) をダウンロードしました`);
}

function generateMarkdownText() {
  const dateStr = new Date().toLocaleString('ja-JP');
  let md = `# 議事録・音声メモ (${dateStr})\n\n`;
  md += `- **総録音時間**: ${elements.timerDisplay.textContent}\n`;
  md += `- **発話数**: ${state.segments.length} 件\n\n`;
  md += `## 文字起こしタイムライン\n\n`;

  state.segments.forEach((seg) => {
    const tagStr = seg.tag ? ` [${getTagLabel(seg.tag)}]` : '';
    md += `- **\`[${seg.timeStr}]\`**${tagStr}: ${seg.text}\n`;
  });

  return md;
}

function downloadText() {
  if (state.segments.length === 0) {
    showToast('書き出すテキストがありません');
    return;
  }
  const md = generateMarkdownText();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = `transcript_${getTimestampString()}.md`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`議事録テキスト (${filename}) をダウンロードしました`);
}

async function copyTextToClipboard() {
  if (state.segments.length === 0) {
    showToast('コピーするテキストがありません');
    return;
  }
  const md = generateMarkdownText();
  try {
    await navigator.clipboard.writeText(md);
    showToast('文字起こし全文をクリップボードにコピーしました');
  } catch (err) {
    showToast('クリップボードへのコピーに失敗しました');
  }
}

function getTimestampString() {
  const d = new Date();
  return [
    d.getFullYear(),
    (d.getMonth() + 1).toString().padStart(2, '0'),
    d.getDate().toString().padStart(2, '0'),
    '_',
    d.getHours().toString().padStart(2, '0'),
    d.getMinutes().toString().padStart(2, '0'),
    d.getSeconds().toString().padStart(2, '0')
  ].join('');
}

// ============================================================
// 14. イベントリスナー登録
// ============================================================
function setupEventListeners() {
  elements.recordToggleBtn.addEventListener('click', toggleRecording);

  elements.pinButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const pinType = btn.dataset.pinType;
      setPinTag(pinType);
    });
  });

  elements.downloadAudioBtn.addEventListener('click', downloadAudio);
  elements.downloadTextBtn.addEventListener('click', downloadText);
  elements.copyTextBtn.addEventListener('click', copyTextToClipboard);

  elements.clearHistoryBtn.addEventListener('click', clearAllHistory);

  elements.clearCurrentTranscriptBtn.addEventListener('click', () => {
    if (state.isRecording) {
      showToast('録音中は文字起こしをクリアできません');
      return;
    }
    if (confirm('現在の文字起こし表示をクリアしますか？')) {
      state.segments = [];
      renderSegments();
      updateSegmentCount();
    }
  });

  elements.autoscrollCheckbox.addEventListener('change', (e) => {
    state.autoScroll = e.target.checked;
  });

  elements.themeToggleBtn.addEventListener('click', () => {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    state.theme = newTheme;
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('voicesync_theme', newTheme);
    elements.themeToggleBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
  });

  setupAudioSync();
}

// ============================================================
// 15. トースト通知ヘルパー
// ============================================================
let toastTimeout = null;
function showToast(message) {
  const toast = elements.toast;
  toast.textContent = message;
  toast.classList.add('show');

  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}
