import { Module } from '@nestjs/common';
import { JudgeService } from './judge.service';
import { JudgeController } from './judge.controller';
import { StandingsModule } from '../standings/standings.module';

@Module({
  imports: [StandingsModule],
  controllers: [JudgeController],
  providers: [JudgeService],
  exports: [JudgeService],
})
export class JudgeModule {}
