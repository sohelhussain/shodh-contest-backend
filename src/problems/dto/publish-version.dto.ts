import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsArray,
  ValidateNested,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TestCaseDto } from './create-problem.dto';

export class PublishVersionDto {
  @ApiProperty({ example: 'Sum of Two Numbers v2' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Updated problem description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 100 })
  @IsNumber()
  @Min(1)
  points: number;

  @ApiProperty({ example: 2000 })
  @IsNumber()
  @Min(100)
  timeLimitMs: number;

  @ApiProperty({ example: 128 })
  @IsNumber()
  @Min(16)
  memoryLimitMb: number;

  @ApiProperty({ type: [TestCaseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases: TestCaseDto[];
}
