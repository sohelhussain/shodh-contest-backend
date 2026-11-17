import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { SubmissionsService } from './submissions.service';
import { CreateSubmissionDto } from './dto/create-submission.dto';
import { RejudgeDto } from './dto/rejudge.dto';
import { DevAuthGuard } from '../auth/guards/dev-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Submissions')
@Controller()
@UseGuards(DevAuthGuard)
@ApiHeader({ name: 'x-dev-user-id', required: true })
@ApiHeader({ name: 'x-dev-signature', required: true })
export class SubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  @Post('contests/:id/submissions')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit code for a contest problem (Participant)' })
  async submit(
    @CurrentUser() user: any,
    @Param('id') contestId: string,
    @Body() dto: CreateSubmissionDto,
  ) {
    return this.submissionsService.submit(user, contestId, dto);
  }

  @Get('submissions/:id')
  @ApiOperation({ summary: 'Get submission status (own code or organizer)' })
  async getSubmission(@CurrentUser() user: any, @Param('id') id: string) {
    return this.submissionsService.getSubmission(user, id);
  }

  @Post('submissions/:id/rejudge')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Rejudge a submission (Organizer only)' })
  async rejudge(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: RejudgeDto,
  ) {
    return this.submissionsService.rejudge(user, id, dto);
  }
}
