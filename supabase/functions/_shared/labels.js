// 前端與伺服器共用的標籤文字
export const FLAG_LABELS = {
  OUT_OF_FENCE: '位置不在據點範圍',
  LOW_ACCURACY: '定位精度不足',
  NO_GPS: '無定位資料',
  TOO_FAST: '間隔過短',
  OUT_OF_ORDER: '未依順序',
  DELAYED_UPLOAD: '延遲上傳',
  CLOCK_SKEW: '手機時間異常',
  NON_LIVE_PHOTO: '非即時拍攝',
  UV_SKIPPED: '未通過生物辨識',
  SELFIE_MISSED: '未完成自拍確認',
};
export const flagLabel = f => FLAG_LABELS[f] || f;
export const REVIEW_LABELS = { none: '', pending: '待覆核', ok: '已確認', rejected: '退回' };
export const INCIDENT_STATUS = { open: '未處理', processing: '處理中', closed: '已結案' };
