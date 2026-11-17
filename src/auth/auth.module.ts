import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { DevAuthGuard } from './guards/dev-auth.guard';
import { JudgeAuthGuard } from './guards/judge-auth.guard';
import { AccessControlService } from './access-control.service';

@Global()
@Module({
  providers: [AuthService, DevAuthGuard, JudgeAuthGuard, AccessControlService],
  exports: [AuthService, DevAuthGuard, JudgeAuthGuard, AccessControlService],
})
export class AuthModule {}
