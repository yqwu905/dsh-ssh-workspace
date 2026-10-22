/** Validated browser/file inputs. No private key material is accepted by this plugin. */
import { z } from 'zod';
export declare const absoluteRemotePath: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
export declare const recordId: z.ZodString;
export declare const helperLaunch: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"executable">;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"node-script">;
    node: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    bootstrapPath: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    bootstrapHash: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "kind">;
/** A reverse forward is private to the remote loopback interface. */
export declare const tunnelInput: z.ZodObject<{
    remotePort: z.ZodNumber;
    host: z.ZodDefault<z.ZodEnum<{
        "127.0.0.1": "127.0.0.1";
        localhost: "localhost";
        "::1": "::1";
    }>>;
    port: z.ZodNumber;
}, z.core.$strict>;
export declare const serverInput: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    label: z.ZodString;
    host: z.ZodString;
    helperMode: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        manual: "manual";
    }>>;
    helper: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    helperHash: z.ZodOptional<z.ZodString>;
    launch: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"executable">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"node-script">;
        node: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        bootstrapPath: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
        bootstrapHash: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "kind">>;
    tunnels: z.ZodDefault<z.ZodArray<z.ZodObject<{
        remotePort: z.ZodNumber;
        host: z.ZodDefault<z.ZodEnum<{
            "127.0.0.1": "127.0.0.1";
            localhost: "localhost";
            "::1": "::1";
        }>>;
        port: z.ZodNumber;
    }, z.core.$strict>>>;
    executableMap: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    hostExecutables: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const workspaceInput: z.ZodObject<{
    serverId: z.ZodString;
    remotePath: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    title: z.ZodString;
}, z.core.$strict>;
export type ServerInput = z.infer<typeof serverInput>;
export type ServerRecord = Omit<ServerInput, 'id'> & {
    id: string;
};
export type WorkspaceInput = z.infer<typeof workspaceInput>;
export declare const workspaceRecord: z.ZodObject<{
    serverId: z.ZodString;
    remotePath: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    title: z.ZodString;
    id: z.ZodString;
    mountPath: z.ZodString;
    workspaceId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type WorkspaceRecord = z.infer<typeof workspaceRecord>;
export declare const persistedState: z.ZodObject<{
    version: z.ZodLiteral<1>;
    servers: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        host: z.ZodString;
        helperMode: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>>;
        helper: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
        helperHash: z.ZodOptional<z.ZodString>;
        launch: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"executable">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"node-script">;
            node: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            bootstrapPath: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
            bootstrapHash: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>;
        tunnels: z.ZodDefault<z.ZodArray<z.ZodObject<{
            remotePort: z.ZodNumber;
            host: z.ZodDefault<z.ZodEnum<{
                "127.0.0.1": "127.0.0.1";
                localhost: "localhost";
                "::1": "::1";
            }>>;
            port: z.ZodNumber;
        }, z.core.$strict>>>;
        executableMap: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        hostExecutables: z.ZodDefault<z.ZodArray<z.ZodString>>;
        id: z.ZodString;
    }, z.core.$strict>>;
    workspaces: z.ZodArray<z.ZodObject<{
        serverId: z.ZodString;
        remotePath: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        title: z.ZodString;
        id: z.ZodString;
        mountPath: z.ZodString;
        workspaceId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    retiredMounts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        serverId: z.ZodString;
        remotePath: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        title: z.ZodString;
        id: z.ZodString;
        mountPath: z.ZodString;
        workspaceId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
