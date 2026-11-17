import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEnum, IsNumber, IsArray, ValidateNested, IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { Verdict } from '@prisma/client';

export class JudgeClaimDto {
  @ApiProperty({ example: 'worker-node-1' })
  @IsString()
  @IsNotEmpty()
  workerId: string;
}

export class JudgeHeartbeatDto {
  @ApiProperty({ example: 'uuid-lease-token' })
  @IsString()
  @IsNotEmpty()
  leaseToken: string;

  @ApiProperty({ example: 'worker-node-1' })
  @IsString()
  @IsNotEmpty()
  workerId: string;
}

export class JudgeTestResultDto {
  @ApiProperty({ example: 'tc-ts-1' })
  @IsString()
  @IsNotEmpty()
  testCaseId: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  passed: boolean;

  @ApiProperty({ example: 45 })
  @IsNumber()
  executionTimeMs: number;

  @ApiProperty({ example: '3\n', required: false })
  @IsString()
  @IsOptional()
  output?: string;

  @ApiProperty({ example: null, required: false })
  @IsString()
  @IsOptional()
  error?: string;
}

export class JudgeCompleteDto {
  @ApiProperty({ example: 'uuid-lease-token' })
  @IsString()
  @IsNotEmpty()
  leaseToken: string;

  @ApiProperty({ example: 'worker-node-1' })
  @IsString()
  @IsNotEmpty()
  workerId: string;

  @ApiProperty({ enum: Verdict, example: Verdict.ACCEPTED })
  @IsEnum(Verdict)
  verdict: Verdict;

  @ApiProperty({ example: 100 })
  @IsNumber()
  score: number;

  @ApiProperty({ example: 85 })
  @IsNumber()
  executionTimeMs: number;

  @ApiProperty({ type: [JudgeTestResultDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JudgeTestResultDto)
  testResults: JudgeTestResultDto[];
}
