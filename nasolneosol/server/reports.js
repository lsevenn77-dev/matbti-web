// 신고 접수·처리: data/reports.jsonl 에 한 줄에 한 건씩 저장한다. 처리 상태가 바뀌면 파일을 다시 쓴다.
// [임시] 규모가 커지면 DB 로 옮긴다.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const REPORT_REASONS = {
  abuse: '욕설·비하·괴롭힘',
  sexual: '성적인 말이나 사진',
  contact: '원치 않는 연락처·만남 요구',
  fake: '사칭·허위 프로필',
  spam: '스팸·홍보·금전 요구',
  minor: '미성년자로 보임',
  other: '기타',
};
export const REPORT_STATUS = { open: '접수', resolved: '처리 완료', dismissed: '기각' };
const PER_DAY = 20; // 한 사람이 하루에 보낼 수 있는 신고 수

export class ReportError extends Error {}

export class Reports {
  constructor(dir, { now = Date.now } = {}) {
    this.file = dir ? path.join(dir, 'reports.jsonl') : null;
    this.now = now;
    this.list = [];
    if (this.file && fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.list.push(JSON.parse(line)); } catch { /* 깨진 줄은 건너뛴다 */ }
      }
    }
  }

  rewrite() {
    if (!this.file) return;
    fs.writeFileSync(this.file + '.tmp', this.list.map((r) => JSON.stringify(r)).join('\n') + (this.list.length ? '\n' : ''));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  add({ reporter, target, reason, detail = '', context, roomId = null, evidence = null }) {
    if (!REPORT_REASONS[reason]) throw new ReportError('신고 사유를 골라 줘');
    if (reporter === target) throw new ReportError('나를 신고할 수는 없어');
    const now = this.now();
    const day = this.list.filter((r) => r.reporter === reporter && now - r.at < 24 * 3600 * 1000);
    if (day.length >= PER_DAY) throw new ReportError('오늘은 신고를 너무 많이 했어. 내일 다시 해 줘');
    if (day.some((r) => r.target === target && r.reason === reason && now - r.at < 10 * 60 * 1000)) {
      throw new ReportError('같은 내용으로 방금 신고했어. 확인 중이야');
    }
    const rec = { id: randomBytes(6).toString('hex'), at: now, reporter, target, reason, reasonLabel: REPORT_REASONS[reason], detail: String(detail).slice(0, 500), context, roomId, evidence, status: 'open' };
    this.list.push(rec);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    console.log(`[report] ${rec.id} ${reason} ${context} ${reporter.slice(0, 8)} → ${target.slice(0, 8)}`);
    return rec;
  }

  get(id) {
    return this.list.find((r) => r.id === id) ?? null;
  }

  /** 운영자 처리: 상태와 메모 */
  update(id, { status, note, action }) {
    const r = this.get(id);
    if (!r) throw new ReportError('신고를 찾을 수 없어');
    if (status) {
      if (!REPORT_STATUS[status]) throw new ReportError('알 수 없는 상태');
      r.status = status;
    }
    if (note !== undefined) r.note = String(note).slice(0, 500);
    if (action) r.action = action;
    r.handledAt = this.now();
    this.rewrite();
    return r;
  }

  /** 한 사람이 받은 신고 수 */
  countAgainst(userId) {
    return this.list.filter((r) => r.target === userId).length;
  }

  /** 처리 완료 후 1년이 지난 신고 기록은 지운다 (개인정보처리방침). 접수 상태는 남긴다 */
  purgeOld(keepMs = 365 * 24 * 3600 * 1000) {
    const now = this.now();
    const before = this.list.length;
    this.list = this.list.filter((r) => r.status === 'open' || now - (r.handledAt ?? r.at) < keepMs);
    if (this.list.length !== before) this.rewrite();
  }
}
