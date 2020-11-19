import {
    ExportDeclaration,
    factory,
    FindAllReferences,
    getUniqueName,
    Identifier,
    ImportDeclaration,
    ImportSpecifier,
    isExportDeclaration,
    isImportDeclaration,
    isNamespaceImport,
    isPropertyAccessExpression,
    isStringLiteral,
    Program,
    PropertyAccessExpression,
    resolveModuleName,
    SourceFile,
    Symbol,
    SymbolFlags,
    textChanges,
    TypeChecker
} from 'typescript';
import { cast, partition } from './utils';
import { MixinHost } from './hosts';

enum SymbolKind {
    DefinitelyType = 'DefinitelyType',
    MaybeValue = 'MaybeValue'
}

export enum Features {
    ExportRewrite,
    ImportRewrite
}

const FullFeatures = new Set([Features.ExportRewrite, Features.ImportRewrite]);

export function visit(
    sourceFile: SourceFile,
    program: Program,
    host: MixinHost,
    changeTracker: textChanges.ChangeTracker,
    features: Set<Features> = FullFeatures
) {
    const checker = program.getTypeChecker();

    if (features.has(Features.ExportRewrite)) {
        rewriteExport(sourceFile, program, checker, host, changeTracker);
    }
    if (features.has(Features.ImportRewrite)) {
        rewriteImport(sourceFile, checker, changeTracker);
    }
}

function partitionSymbolByTypeAndValue(symbols: Symbol[]) {
    return partition(symbols, symbol => {
        if (
            !(symbol.flags & SymbolFlags.Value) &&
            symbol.flags & SymbolFlags.Type
        ) {
            return SymbolKind.DefinitelyType;
        }
        return SymbolKind.MaybeValue;
    });
}

function rewriteExport(
    sourceFile: SourceFile,
    program: Program,
    checker: TypeChecker,
    host: MixinHost,
    changeTracker: textChanges.ChangeTracker
) {
    const compilerOptions = program.getCompilerOptions();
    const declarationExportsMap = new Map<ExportDeclaration, Symbol[]>();
    sourceFile.statements.forEach(stmt => {
        if (isExportDeclaration(stmt)) {
            visitExportDeclaration(stmt);
        }
    });

    for (const [decl, exports] of declarationExportsMap.entries()) {
        const newExportDeclarations = generateExportDeclaration(decl, exports);
        changeTracker.replaceNodeWithNodes(
            sourceFile,
            decl,
            newExportDeclarations
        );
    }

    function visitExportDeclaration(declaration: ExportDeclaration) {
        if (declaration.exportClause || !declaration.moduleSpecifier) {
            // ignore if export * as ns from 'xx' or grammar error
            return;
        }

        const specifier = cast(declaration.moduleSpecifier, isStringLiteral);
        const result = resolveModuleName(
            specifier.text,
            sourceFile.fileName,
            compilerOptions,
            host
        );
        if (
            !result.resolvedModule ||
            result.resolvedModule.isExternalLibraryImport
        ) {
            // ignore missing modules and external libs
            return;
        }

        const resolvedFileName = result.resolvedModule.resolvedFileName;
        const targetFile = program.getSourceFile(resolvedFileName);
        if (!targetFile) {
            // ignore if cannot find file
            return;
        }

        const sourceFileSymbol = checker.getSymbolAtLocation(targetFile);
        if (!sourceFileSymbol) {
            // ignore if cannot find symbol
            return;
        }

        const moduleExports = checker.getExportsOfModule(sourceFileSymbol);
        declarationExportsMap.set(declaration, moduleExports);
    }
}

function generateExportDeclaration(
    exportDeclaration: ExportDeclaration,
    symbols: Symbol[]
) {
    const { DefinitelyType, MaybeValue } = partitionSymbolByTypeAndValue(
        symbols
    );

    const result: ExportDeclaration[] = [];
    if (DefinitelyType?.length) {
        result.push(createExportDeclarationFromSymbols(DefinitelyType, true));
    }
    if (MaybeValue?.length) {
        result.push(createExportDeclarationFromSymbols(MaybeValue, false));
    }

    return result;

    function createExportDeclarationFromSymbols(
        symbols: Symbol[],
        isTypeOnly: boolean
    ) {
        return factory.createExportDeclaration(
            undefined,
            undefined,
            isTypeOnly,
            factory.createNamedExports(
                symbols.map(symbol =>
                    factory.createExportSpecifier(undefined, symbol.name)
                )
            ),
            exportDeclaration.moduleSpecifier
        );
    }
}

interface ImportDeclInfo {
    referencesToRewrite: Map<Symbol, PropertyAccessExpression[]>;
    symbolAliasMap: Map<Symbol, string>;
    notPureImport: boolean;
}

function rewriteImport(
    sourceFile: SourceFile,
    checker: TypeChecker,
    changeTracker: textChanges.ChangeTracker
) {
    const declarationImportsMap = new Map<ImportDeclaration, ImportDeclInfo>();

    sourceFile.statements.forEach(stmt => {
        if (isImportDeclaration(stmt)) {
            visitImportDeclaration(stmt);
        }
    });

    for (const [decl, info] of declarationImportsMap.entries()) {
        rewriteReference(info, changeTracker, sourceFile);

        const imports = generateImportDeclaration(decl, info);
        changeTracker.replaceNodeWithNodes(sourceFile, decl, imports);
    }

    function visitImportDeclaration(declaration: ImportDeclaration) {
        if (
            !declaration.importClause ||
            !declaration.importClause.namedBindings ||
            !isNamespaceImport(declaration.importClause.namedBindings)
        ) {
            // ignore if import is not import * as ns from 'xx'
            return;
        }

        let notPureImport = false;
        const accessReferences: PropertyAccessExpression[] = [];

        FindAllReferences.Core.eachSymbolReferenceInFile(
            declaration.importClause.namedBindings.name,
            checker,
            sourceFile,
            id => {
                if (!isPropertyAccessExpression(id.parent)) {
                    notPureImport = true;
                } else {
                    accessReferences.push(id.parent);
                }
            }
        );

        const symbolAliasMap = new Map<Symbol, string>();
        const referencesToRewrite = new Map<
            Symbol,
            PropertyAccessExpression[]
        >();

        accessReferences.forEach(propertyAccess => {
            const symbolMaybeAlias = checker.getSymbolAtLocation(
                propertyAccess
            );
            if (!symbolMaybeAlias) {
                return;
            }
            const symbol =
                symbolMaybeAlias.flags & SymbolFlags.Alias
                    ? checker.getAliasedSymbol(symbolMaybeAlias)
                    : symbolMaybeAlias;

            const references = referencesToRewrite.get(symbol) || [];
            references.push(propertyAccess);
            referencesToRewrite.set(symbol, references);

            if (
                !symbolAliasMap.has(symbol) &&
                checker.resolveName(
                    symbol.name,
                    propertyAccess,
                    SymbolFlags.All,
                    true
                )
            ) {
                symbolAliasMap.set(
                    symbol,
                    getUniqueName(symbol.name, sourceFile)
                );
            }
        });

        declarationImportsMap.set(declaration, {
            referencesToRewrite,
            notPureImport,
            symbolAliasMap
        });
    }
}

function rewriteReference(
    info: ImportDeclInfo,
    changeTracker: textChanges.ChangeTracker,
    sourceFile: SourceFile
) {
    const { referencesToRewrite, symbolAliasMap } = info;
    for (const [symbol, references] of referencesToRewrite.entries()) {
        const symbolName = symbolAliasMap.get(symbol) ?? symbol.name;
        references.forEach(reference => {
            changeTracker.replaceNode(
                sourceFile,
                reference,
                factory.createIdentifier(symbolName)
            );
        });
    }
}

function generateImportDeclaration(
    declaration: ImportDeclaration,
    info: ImportDeclInfo
): ImportDeclaration[] {
    const { referencesToRewrite, notPureImport, symbolAliasMap } = info;
    const { DefinitelyType, MaybeValue } = partitionSymbolByTypeAndValue(
        Array.from(referencesToRewrite.keys())
    );

    const result: ImportDeclaration[] = [];

    if (DefinitelyType?.length) {
        result.push(createImportDeclarationFromSymbols(DefinitelyType, true));
    }
    if (MaybeValue?.length) {
        result.push(createImportDeclarationFromSymbols(MaybeValue, false));
    }
    if (notPureImport) {
        result.push(declaration);
    }

    return result;

    function createImportDeclarationFromSymbols(
        symbols: Symbol[],
        isTypeOnly: boolean
    ) {
        return factory.createImportDeclaration(
            undefined,
            undefined,
            factory.createImportClause(
                isTypeOnly,
                undefined,
                factory.createNamedImports(
                    symbols.map(x => {
                        const name = symbolAliasMap.get(x) ?? x.name;
                        const propertyName = symbolAliasMap.has(x)
                            ? factory.createIdentifier(x.name)
                            : undefined;

                        return factory.createImportSpecifier(
                            propertyName,
                            factory.createIdentifier(name)
                        );
                    })
                )
            ),
            declaration.moduleSpecifier
        );
    }
}
