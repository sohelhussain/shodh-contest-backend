import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsDateString, IsOptional } from 'class-validator';

export class CreateContestDto {
  @ApiProperty({ example: 'org-alpha' })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({ example: 'Alpha Code Sprint 2026' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Weekly coding challenge', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: '2026-11-17T18:00:00.000Z' })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({ example: '2026-11-17T21:00:00.000Z' })
  @IsDateString()
  @IsNotEmpty()
  endTime: string;
}
