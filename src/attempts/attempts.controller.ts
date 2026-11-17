import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { AttemptsService } from './attempts.service';
import { DevAuthGuard } from '../auth/guards/dev-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Attempts')
@Controller('attempts')
@UseGuards(DevAuthGuard)
@ApiHeader({ name: 'x-dev-user-id', required: true })
@ApiHeader({ name: 'x-dev-signature', required: true })
export class AttemptsController {
  constructor(private readonly attemptsService: AttemptsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get attempt details (Organizer full, participant own redacted)' })
  async getAttemptDetails(@CurrentUser() user: any, @Param('id') id: string) {
    return this.attemptsService.getAttemptDetails(user, id);
  }
}
