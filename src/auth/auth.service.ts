import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private get secret(): string {
    return process.env.DEV_AUTH_SECRET || 'change_me_dev_only';
  }

  generateSignature(userId: string): string {
    return crypto.createHmac('sha256', this.secret).update(userId).digest('hex');
  }

  verifySignature(userId: string, signature: string): boolean {
    if (!userId || !signature) return false;
    const expected = this.generateSignature(userId);
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  verifyJudgeToken(token: string): boolean {
    const expected = process.env.JUDGE_API_TOKEN || 'change_me_judge_only';
    if (!token || expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  }
}
