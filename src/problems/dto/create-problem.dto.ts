import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TestCaseDto {
  @ApiProperty({ example: '1 2\n' })
  @IsString()
  @IsNotEmpty()
  input: string;

  @ApiProperty({ example: '3\n' })
  @IsString()
  @IsNotEmpty()
  expectedOutput: string;

  @ApiProperty({ example: false, default: false })
  @IsBoolean()
  @IsOptional()
  isHidden?: boolean;

  @ApiProperty({ example: 0, default: 0 })
  @IsNumber()
  @IsOptional()
  orderIndex?: number;
}

export class CreateProblemDto {
  @ApiProperty({ example: 'Sum of Two Numbers' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Read two numbers and output their sum.' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 100, default: 100 })
  @IsNumber()
  @Min(1)
  points: number;

  @ApiProperty({ example: 2000, default: 2000 })
  @IsNumber()
  @Min(100)
  timeLimitMs: number;

  @ApiProperty({ example: 128, default: 128 })
  @IsNumber()
  @Min(16)
  memoryLimitMb: number;

  @ApiProperty({ type: [TestCaseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases: TestCaseDto[];
}
