import {
    ArgumentMetadata,
    BadRequestException,
    Injectable,
    PipeTransform,
} from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { formatZodIssues } from '../chat/schemas/chat-completion.schema';

/**
 * Generic Zod-backed validation pipe. Use case-by-case:
 *
 *   @Body(new ZodValidationPipe(ChatCompletionBodySchema)) body: ChatCompletionBody
 *
 * Failures throw a BadRequestException whose `response` mimics the OpenAI
 * error envelope so existing client parsers don't choke.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
    constructor(private readonly schema: ZodSchema) {}

    transform(value: unknown, _metadata: ArgumentMetadata): unknown {
        const result = this.schema.safeParse(value);
        if (!result.success) {
            const err = result.error as ZodError;
            throw new BadRequestException({
                error: {
                    message: 'Invalid request body',
                    type: 'invalid_request_error',
                    param: null,
                    code: 'invalid_request',
                    issues: formatZodIssues(err),
                },
            });
        }
        return result.data;
    }
}
