import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsObject } from 'class-validator';

export class CreateSubmissionDto {
  @ApiProperty({ example: 'prob-two-sum' })
  @IsString()
  @IsNotEmpty()
  problemId: string;

  @ApiProperty({ example: 'import sys\nprint("Hello")' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 'python', default: 'python' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiProperty({ example: 'client-sub-12345-abc' })
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @ApiProperty({ example: { cpus: 0.5, memoryMb: 128 }, required: false })
  @IsObject()
  @IsOptional()
  runtimeConfig?: Record<string, any>;
}
