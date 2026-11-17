import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RejudgeDto {
  @ApiProperty({ example: 'pv-two-sum-1', required: false })
  @IsString()
  @IsOptional()
  problemVersionId?: string;

  @ApiProperty({ example: 'ts-two-sum-1', required: false })
  @IsString()
  @IsOptional()
  suiteVersionId?: string;
}
