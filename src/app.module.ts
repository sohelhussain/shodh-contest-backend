import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { StandingsModule } from './standings/standings.module';
import { ContestsModule } from './contests/contests.module';
import { ProblemsModule } from './problems/problems.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { AttemptsModule } from './attempts/attempts.module';
import { JudgeModule } from './judge/judge.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    StandingsModule,
    ContestsModule,
    ProblemsModule,
    SubmissionsModule,
    AttemptsModule,
    JudgeModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
