import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { JudgeService } from './judge.service';
import { JudgeClaimDto, JudgeHeartbeatDto, JudgeCompleteDto } from './dto/judge.dto';
import { JudgeAuthGuard } from '../auth/guards/judge-auth.guard';

@ApiTags('Judge')
@Controller('judge')
@UseGuards(JudgeAuthGuard)
@ApiHeader({ name: 'x-judge-token', required: true })
export class JudgeController {
  constructor(private readonly judgeService: JudgeService) {}

  @Post('jobs/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim next available job (Worker only)' })
  async claimJob(@Body() dto: JudgeClaimDto) {
    return this.judgeService.claimJob(dto);
  }

  @Post('jobs/:id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renew worker lease heartbeat' })
  async heartbeat(@Param('id') jobId: string, @Body() dto: JudgeHeartbeatDto) {
    return this.judgeService.heartbeat(jobId, dto);
  }

  @Post('attempts/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete attempt judging with CAS' })
  async completeAttempt(
    @Param('id') attemptId: string,
    @Body() dto: JudgeCompleteDto,
  ) {
    return this.judgeService.completeAttempt(attemptId, dto);
  }
}
