import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { seed } from '../prisma/seed';

export function makeDevHeaders(
  userId: string,
  secret = process.env.DEV_AUTH_SECRET || 'change_me_dev_only',
) {
  const signature = crypto.createHmac('sha256', secret).update(userId).digest('hex');
  return {
    'x-dev-user-id': userId,
    'x-dev-signature': signature,
  };
}

export function makeJudgeHeaders(token = process.env.JUDGE_API_TOKEN || 'change_me_judge_only') {
  return {
    'x-judge-token': token,
  };
}

export async function createTestingApp(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();
  const prisma = app.get(PrismaService);
  await seed();

  return { app, prisma };
}
