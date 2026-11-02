import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAliasAccessController } from './admin-alias-access.controller';
import type { ClientService } from '../auth/client.service';
import type { ProviderRegistryService } from '../providers/provider.registry';
import type {
    AliasAccessDescription,
    AliasAccessService,
} from '../access/alias-access.service';

const CLIENT_ID = 'client-1';

function makeController() {
    const access = {
        describe: jest.fn(
            (clientId: string): AliasAccessDescription => ({
                clientId,
                mode: 'unrestricted',
                aliases: [],
            }),
        ),
        replace: jest.fn(
            (clientId: string, aliasKeys: readonly string[]): AliasAccessDescription => ({
                clientId,
                mode: 'restricted',
                aliases: [...aliasKeys].sort(),
            }),
        ),
        clear: jest.fn(
            (clientId: string): AliasAccessDescription => ({
                clientId,
                mode: 'unrestricted',
                aliases: [],
            }),
        ),
        getAccess: jest.fn(),
        isPermitted: jest.fn(),
    };

    const clients = {
        findById: jest.fn((id: string) => (id === CLIENT_ID ? { id: CLIENT_ID } : undefined)),
    };

    const registry = {
        aliases: {
            codex: ['nan/qwen3.6'],
            latin: ['nan/mimo-v2.5'],
            slave: ['nan/deepseek-v4-flash'],
        } as Record<string, string[]>,
    };

    const controller = new AdminAliasAccessController(
        access as unknown as AliasAccessService,
        clients as unknown as ClientService,
        registry as unknown as ProviderRegistryService,
    );

    return { controller, access, clients, registry };
}

describe('AdminAliasAccessController.list', () => {
    it('returns the state described by the service', () => {
        const { controller, access } = makeController();
        access.describe.mockReturnValueOnce({
            clientId: CLIENT_ID,
            mode: 'restricted',
            aliases: ['codex', 'slave'],
        });

        const out = controller.list(CLIENT_ID);

        expect(access.describe).toHaveBeenCalledWith(CLIENT_ID);
        expect(out).toEqual({
            clientId: CLIENT_ID,
            mode: 'restricted',
            aliases: ['codex', 'slave'],
        });
    });

    it('404s on an unknown client instead of describing it', () => {
        const { controller, access } = makeController();

        expect(() => controller.list('nope')).toThrow(NotFoundException);
        expect(access.describe).not.toHaveBeenCalled();
    });
});

describe('AdminAliasAccessController.replace', () => {
    it('replaces the whole set and returns the new state', () => {
        const { controller, access } = makeController();

        const out = controller.replace(CLIENT_ID, { aliases: ['slave', 'codex'] });

        expect(access.replace).toHaveBeenCalledWith(CLIENT_ID, ['slave', 'codex']);
        expect(out).toEqual({
            clientId: CLIENT_ID,
            mode: 'restricted',
            aliases: ['codex', 'slave'],
        });
    });

    it('404s on an unknown client and writes nothing', () => {
        const { controller, access } = makeController();

        expect(() => controller.replace('nope', { aliases: ['codex'] })).toThrow(
            NotFoundException,
        );
        expect(access.replace).not.toHaveBeenCalled();
    });

    it('rejects an empty array and writes nothing, pointing at DELETE', () => {
        const { controller, access } = makeController();

        // With "no rows means unrestricted", accepting `[]` here would silently
        // grant FULL access to an operator who meant to remove it.
        let error: BadRequestException | undefined;
        try {
            controller.replace(CLIENT_ID, { aliases: [] });
        } catch (err) {
            error = err as BadRequestException;
        }

        expect(error).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify(error?.getResponse())).toContain('DELETE');
        expect(access.replace).not.toHaveBeenCalled();
    });

    it('rejects an alias absent from the registry and writes nothing', () => {
        const { controller, access } = makeController();

        expect(() => controller.replace(CLIENT_ID, { aliases: ['codex', 'nope'] })).toThrow(
            BadRequestException,
        );
        expect(access.replace).not.toHaveBeenCalled();
    });

    it('rejects a duplicate alias and writes nothing', () => {
        const { controller, access } = makeController();

        expect(() =>
            controller.replace(CLIENT_ID, { aliases: ['codex', 'codex'] }),
        ).toThrow(BadRequestException);
        expect(access.replace).not.toHaveBeenCalled();
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
        'rejects the prototype name %s as an unknown alias',
        (name) => {
            const { controller, access } = makeController();

            // The registry check is an OWN-property test: a truthiness lookup
            // would accept everything inherited from `Object.prototype`.
            expect(() => controller.replace(CLIENT_ID, { aliases: [name] })).toThrow(
                BadRequestException,
            );
            expect(access.replace).not.toHaveBeenCalled();
        },
    );

    it('rejects a malformed body through the zod pipe', () => {
        const { controller, access } = makeController();

        expect(() =>
            controller.replace(CLIENT_ID, { aliases: 'codex' } as unknown as {
                aliases: string[];
            }),
        ).toThrow(BadRequestException);
        expect(access.replace).not.toHaveBeenCalled();
    });
});

describe('AdminAliasAccessController.clear', () => {
    it('clears every row and returns the unrestricted state', () => {
        const { controller, access } = makeController();

        const out = controller.clear(CLIENT_ID);

        expect(access.clear).toHaveBeenCalledWith(CLIENT_ID);
        expect(out).toEqual({ clientId: CLIENT_ID, mode: 'unrestricted', aliases: [] });
    });

    it('404s on an unknown client and writes nothing', () => {
        const { controller, access } = makeController();

        expect(() => controller.clear('nope')).toThrow(NotFoundException);
        expect(access.clear).not.toHaveBeenCalled();
    });
});
