import { ConsoleLogger, Injectable } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import { ENV, PROJECT } from "./app.enviroment";

@Injectable()
export class AppJsonLogger extends ConsoleLogger {
    private printJson(
        level: string,
        message: any,
        context?: string,
        stack?: string,
    ) {
        if (ENV === "dev") {
            const ctx = context || this.context || "App";
            switch (level) {
                case "INFO":
                    super.log(message, ctx);
                    break;
                case "ERROR":
                    super.error(message, stack, ctx);
                    break;
                case "WARN":
                    super.warn(message, ctx);
                    break;
                case "DEBUG":
                    super.debug(message, ctx);
                    break;
                case "VERBOSE":
                    super.verbose(message, ctx);
                    break;
            }
            return;
        }

        const logData = {
            app: PROJECT,
            ts: new Date().toISOString(),
            level,
            context: context || this.context || "App",
            msg: message,
            ...(stack && { stack }),
            env: ENV,
        };

        console.log(JSON.stringify(logData));

        if (level === "ERROR") {
            Sentry.captureException(
                message instanceof Error ? message : new Error(message),
                {
                    extra: logData,
                    tags: { context: logData.context },
                    level: "error",
                },
            );
        }
    }

    log(message: any, context?: string) {
        this.printJson("INFO", message, context);
    }

    error(message: any, stack?: string, context?: string) {
        this.printJson("ERROR", message, context, stack);
    }

    warn(message: any, context?: string) {
        this.printJson("WARN", message, context);
    }

    debug(message: any, context?: string) {
        this.printJson("DEBUG", message, context);
    }

    verbose(message: any, context?: string) {
        this.printJson("VERBOSE", message, context);
    }
}
