import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { Response } from 'express';
import { ContestsService } from './contests.service';
import { CreateContestDto } from './dto/create-contest.dto';
import { DevAuthGuard } from '../auth/guards/dev-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Contests')
@Controller('contests')
@UseGuards(DevAuthGuard)
@ApiHeader({ name: 'x-dev-user-id', required: true })
@ApiHeader({ name: 'x-dev-signature', required: true })
export class ContestsController {
  constructor(private readonly contestsService: ContestsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new contest (Organizer only)' })
  async createContest(@CurrentUser() user: any, @Body() dto: CreateContestDto) {
    return this.contestsService.createContest(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List contests accessible to user' })
  async listContests(@CurrentUser() user: any) {
    return this.contestsService.listContests(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get contest details' })
  async getContest(@CurrentUser() user: any, @Param('id') id: string) {
    return this.contestsService.getContest(user, id);
  }

  @Post(':id/join')
  @ApiOperation({ summary: 'Join a contest' })
  async joinContest(@CurrentUser() user: any, @Param('id') id: string) {
    return this.contestsService.joinContest(user, id);
  }

  @Get(':id/leaderboard')
  @ApiOperation({ summary: 'Get contest leaderboard' })
  async getLeaderboard(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { etag, updatedAt, entries } = await this.contestsService.getLeaderboard(
      user,
      id,
    );
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(updatedAt).toUTCString());
    return res.status(HttpStatus.OK).json({
      contestId: id,
      updatedAt,
      entries,
    });
  }

  @Get(':id/submissions')
  @ApiOperation({ summary: 'List submissions for a contest with cursor pagination' })
  async listSubmissions(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const numLimit = limit ? parseInt(limit, 10) : 20;
    return this.contestsService.listSubmissions(user, id, numLimit, cursor);
  }
}
