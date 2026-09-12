import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { RootModule } from './root.module';

async function bootstrap() {
  const app = await NestFactory.create(RootModule);
  const frontendOrigins = (
    process.env.FRONTEND_ORIGINS ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Enable CORS for frontend
  app.enableCors({
    origin: frontendOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 NestJS Backend server running on http://localhost:${port}`);
}
void bootstrap();
