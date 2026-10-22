// 系統設定。部署到正式環境時，只需修改本檔。
// SUPABASE_URL 留空時，系統以「示範模式」運作：資料存於本機瀏覽器，不需任何伺服器。
export const CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  ORG_NAME: '元智大學',
  APP_NAME: '校園巡邏',
  // 工號會轉成「工號@網域」作為登入帳號，例如 G1024 → g1024@patrol.yzu.local
  LOGIN_EMAIL_DOMAIN: 'patrol.yzu.local',

  // 緊急聯絡電話：SOS 無法連線時顯示給巡邏員（請替換為實際號碼）
  SOS_PHONES: [
    { label: '校安中心', number: '請填入校安專線' },
    { label: '保全值班室', number: '請填入值班室分機' },
  ],

  SHIFTS: ['夜班 22:00–06:00', '早班 06:00–14:00', '中班 14:00–22:00'],
  WEATHER: ['晴', '陰', '雨', '強風豪雨', '颱風'],
  INCIDENT_TYPES: ['可疑人員', '訪客登記', '學生安全事件', '違規停車', '設施損壞', '漏水積水', '火警或煙霧', '天災影響', '其他'],
  ABNORMAL_CATEGORIES: ['門窗未鎖', '照明故障', '漏水積水', '設備損壞', '消防設備異常', '可疑人員', '環境髒亂或障礙物', '其他'],
  SEVERITIES: ['低', '中', '高', '緊急'],
  INCIDENT_HANDLING: ['已現場處理', '已通報主管', '已通報校安中心', '已通報總務處報修', '已報警'],
  MISSED_REASONS: ['施工封閉', '處理突發事件', '門禁無法進入', '天候因素', '設備故障', '其他'],
  HANDOVER_ITEMS: ['鑰匙串', '無線電', '手電筒', '門禁卡'],

  // 照片
  PHOTO_BUCKET: 'patrol-photos',
  PHOTO_MAX_EDGE: 1280,
  PHOTO_QUALITY: 0.72,
  // 相機無法啟動時，是否允許改用手機內建相機或選檔（該筆紀錄會被標記「非即時拍攝」）
  ALLOW_FILE_PHOTO_FALLBACK: true,

  // 身分驗證
  REQUIRE_BIOMETRIC: false,       // true：未通過指紋／臉部驗證不得開始巡邏
  SELFIE_CHECKS_PER_PATROL: 1,    // 每場巡邏隨機要求自拍確認的次數（0 = 停用）

  // 巡邏軌跡：App 在前景時，每隔幾秒記錄一次位置
  TRACK_INTERVAL_SEC: 60,

  // 防代巡判定門檻（資料庫 supabase/schema.sql 內有同樣的數值，修改時兩邊需一致）
  RULES: {
    MAX_SPEED_MPS: 2.5,        // 兩據點間平均速度上限（公尺／秒），超過即標記「間隔過短」
    MIN_GAP_SEC: 20,           // 任兩次掃描最短間隔（秒）
    DELAY_MIN: 10,             // 掃描後超過幾分鐘才上傳，標記「延遲上傳」
    SKEW_SEC: 120,             // 手機時間比伺服器快超過幾秒，標記「手機時間異常」
    LOW_ACC_M: 50,             // GPS 精度差於此值，標記「定位精度不足」
    BLOCK_MAX_ACC_M: 100,      // GPS 精度優於此值時，超出圍欄才直接拒絕
    FENCE_TOLERANCE_MAX_M: 30, // 圍欄可因 GPS 誤差放寬的上限
  },

  PHOTO_RETENTION_DAYS: 180,
};

export const DEMO = !CONFIG.SUPABASE_URL;
