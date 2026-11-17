import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { ProblemsService } from './problems.service';
import { CreateProblemDto } from './dto/create-problem.dto';
import { PublishVersionDto } from './dto/publish-version.dto';
import { DevAuthGuard } from '../auth/guards/dev-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Problems')
@Controller()
@UseGuards(DevAuthGuard)
@ApiHeader({ name: 'x-dev-user-id', required: true })
@ApiHeader({ name: 'x-dev-signature', required: true })
export class ProblemsController {
  constructor(private readonly problemsService: ProblemsService) {}

  @Post('contests/:id/problems')
  @ApiOperation({ summary: 'Create problem in contest (Organizer only)' })
  async createProblem(
    @CurrentUser() user: any,
    @Param('id') contestId: string,
    @Body() dto: CreateProblemDto,
  ) {
    return this.problemsService.createProblem(user, contestId, dto);
  }

  @Post('problems/:id/versions')
  @ApiOperation({ summary: 'Publish new problem version and test suite (Organizer only)' })
  async publishVersion(
    @CurrentUser() user: any,
    @Param('id') problemId: string,
    @Body() dto: PublishVersionDto,
  ) {
    return this.problemsService.publishVersion(user, problemId, dto);
  }

  @Get('problems/:id')
  @ApiOperation({ summary: 'Get problem details' })
  async getProblem(@CurrentUser() user: any, @Param('id') id: string) {
    return this.problemsService.getProblem(user, id);
  }
}
