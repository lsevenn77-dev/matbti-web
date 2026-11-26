// 신고 접수: data/reports.jsonl 에 한 줄씩 쌓는다 (운영자가 확인). [임시] 관리 화면은 아직 없다.
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
const PER_DAY = 20; // 한 사람이 하루에 보낼 수 있는 신고 수

export class ReportError extends Error {}

export class Reports {
  constructor(dir, { now = Date.now } = {}) {
    this.file = dir ? path.join(dir, 'reports.jsonl') : null;
    this.now = now;
    this.recent = []; // 메모리: 하루 제한·중복 확인용 { id, reporter, target, at }
    this.list = []; // 파일이 없을 때(테스트)도 확인할 수 있게
  }

  add({ reporter, target, reason, detail = '', context, roomId = null, evidence = null }) {
    if (!REPORT_REASONS[reason]) throw new ReportError('신고 사유를 골라 줘');
    if (reporter === target) throw new ReportError('나를 신고할 수는 없어');
    const now = this.now();
    this.recent = this.recent.filter((r) => now - r.at < 24 * 3600 * 1000);
    if (this.recent.filter((r) => r.reporter === reporter).length >= PER_DAY) throw new ReportError('오늘은 신고를 너무 많이 했어. 내일 다시 해 줘');
    if (this.recent.some((r) => r.reporter === reporter && r.target === target && r.reason === reason && now - r.at < 10 * 60 * 1000)) {
      throw new ReportError('같은 내용으로 방금 신고했어. 확인 중이야');
    }
    const rec = { id: randomBytes(6).toString('hex'), at: now, reporter, target, reason, reasonLabel: REPORT_REASONS[reason], detail: String(detail).slice(0, 500), context, roomId, evidence, status: 'open' };
    this.recent.push({ id: rec.id, reporter, target, reason, at: now });
    this.list.push(rec);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    console.log(`[report] ${rec.id} ${reason} ${context} ${reporter.slice(0, 8)} → ${target.slice(0, 8)}`);
    return rec;
  }
}
