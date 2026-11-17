import { Module } from '@nestjs/common';
import { ContestsService } from './contests.service';
import { ContestsController } from './contests.controller';
import { StandingsModule } from '../standings/standings.module';

@Module({
  imports: [StandingsModule],
  controllers: [ContestsController],
  providers: [ContestsService],
  exports: [ContestsService],
})
export class ContestsModule {}
