import {
    textChanges,
    SourceFile,
    Node,
    startEndOverlapsWithStartEnd,
    BaseChange,
    NodeArray,
    TypeParameterDeclaration,
    Statement
} from 'typescript';

interface ChangesFetchable {
    readonly changes: BaseChange[];
}

export class ProxyChangesTracker implements textChanges.ChangeTracker {
    private queue: Map<string, BaseChange[]> = new Map<string, BaseChange[]>();
    private _needAnotherPass: boolean = false;

    constructor(private changeTracker: textChanges.ChangeTracker) {}

    checkOverlap(cb: () => void) {
        const savedChangesLength = this.getChanges().length;
        cb();
        const changes = this.getChanges().slice(savedChangesLength);
        for (const change of changes) {
            const related = this.queue.get(change.sourceFile.fileName) || [];
            if (
                related.some(c =>
                    startEndOverlapsWithStartEnd(
                        c.range.pos,
                        c.range.end,
                        change.range.pos,
                        change.range.end
                    )
                )
            ) {
                this._needAnotherPass = true;
                changes.length = savedChangesLength;
                return;
            } else {
                related.push(change);
            }
            this.queue.set(change.sourceFile.fileName, changes);
        }
    }

    delete(
        sourceFile: SourceFile,
        node: Node | NodeArray<TypeParameterDeclaration>
    ): void {
        this.changeTracker.delete(sourceFile, node);
    }

    finishDeleteDeclarations(): void {
        this.checkOverlap(() => {
            this.changeTracker.finishDeleteDeclarations();
        });
    }

    deleteNodeRange(
        sourceFile: SourceFile,
        startNode: Node,
        endNode: Node,
        options?: textChanges.ConfigurableStartEnd
    ) {
        this.checkOverlap(() => {
            this.changeTracker.deleteNodeRange(
                sourceFile,
                startNode,
                endNode,
                options
            );
        });
    }

    insertNodeBefore(sourceFile: SourceFile, before: Node, newNode: Node) {
        this.checkOverlap(() => {
            this.changeTracker.insertNodeBefore(sourceFile, before, newNode);
        });
    }

    public insertNodeAtTopOfFile(
        sourceFile: SourceFile,
        newNode: Statement,
        blankLineBetween: boolean
    ): void {
        this.checkOverlap(() => {
            this.changeTracker.insertNodeAtTopOfFile(
                sourceFile,
                newNode,
                blankLineBetween
            );
        });
    }

    replaceNode(
        sourceFile: SourceFile,
        oldNode: Node,
        newNode: Node,
        options?: textChanges.ChangeNodeOptions
    ): void {
        this.checkOverlap(() => {
            this.changeTracker.replaceNode(
                sourceFile,
                oldNode,
                newNode,
                options
            );
        });
    }

    getChanges(): BaseChange[] {
        const fetchable = (this.changeTracker as unknown) as ChangesFetchable;
        return fetchable.changes;
    }

    needAnotherPass() {
        return this._needAnotherPass;
    }
}
