import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { appLogger } from './common/logging/logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger OpenAPI documentation at /docs
  const config = new DocumentBuilder()
    .setTitle('Shodh a Code Contest API')
    .setDescription('Coding contest platform API with deterministic judging, standings, and sandboxed runner')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'x-dev-user-id', in: 'header' }, 'x-dev-user-id')
    .addApiKey({ type: 'apiKey', name: 'x-dev-signature', in: 'header' }, 'x-dev-signature')
    .addApiKey({ type: 'apiKey', name: 'x-judge-token', in: 'header' }, 'x-judge-token')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.API_PORT || 3000;
  await app.listen(port);
  appLogger.info({ port }, `Shodh API server started and listening on port ${port}`);
}

bootstrap();
