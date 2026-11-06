import { IsISO8601, IsNotEmpty, IsObject, IsString, Matches, MaxLength } from 'class-validator';

const EXPLICIT_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  patientId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  type: string;

  @IsObject()
  data: Record<string, unknown>;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(EXPLICIT_TIMEZONE, { message: 'ts must include a timezone (Z or ±hh:mm)' })
  ts: string;
}
