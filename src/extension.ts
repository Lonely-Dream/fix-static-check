// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

function getConfig() {
    const config = vscode.workspace.getConfiguration('fix-static-check');
    const minCommentRatio = config.get<number>('minCommentRatio', 0.25);
    var autoInsertCommentValue = config.get<string>('autoInsertCommentValue', "fix METRICS-19");
    if (autoInsertCommentValue.length > 60) {
        autoInsertCommentValue = autoInsertCommentValue.substring(0, 60);
    }
    console.log({ minCommentRatio, autoInsertCommentValue });

    return { minCommentRatio, autoInsertCommentValue };
}

function findfn(rootNode: Parser.SyntaxNode, line: number): Parser.SyntaxNode | null {
    let result: Parser.SyntaxNode|null = null;
    const cursor = rootNode.walk();

    function traverse(node: Parser.SyntaxNode | null) {
        if (!node) {
            return;
        }
        if (node.type === "function_definition") {
            if (line >= node.startPosition.row && line <= node.endPosition.row) {
                result = node;
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            traverse(node.namedChild(i));
        }
    }

    traverse(rootNode);
    return result;
}

function analyzeFunction(fnNode: Parser.SyntaxNode, lines: string[], minCommentRatio:number) {
    const commentLines = new Set<number>();
    const allCodeLines = new Set<number>(); // 临时存储所有可能的代码行
    const processedLines = new Set<number>(); // 跟踪已处理的行号

    // 第一步：先收集所有注释行
    function collectComments(node: Parser.SyntaxNode | null) {
        if (!node) {
            return;
        }

        if (node.type === "comment") {
            const start = node.startPosition.row;
            const end = node.endPosition.row;
            for (let i = start; i <= end; i++) {
                commentLines.add(i);
                processedLines.add(i); // 标记为已处理
            }
        }

        // 递归处理子节点
        for (let i = 0; i < node.namedChildCount; i++) {
            collectComments(node.namedChild(i));
        }
    }

    // 第二步：收集所有可能的代码行（排除已处理的注释行）
    function collectCodeLines(node: Parser.SyntaxNode | null) {
        if (!node) {
            return;
        }

        if (node.isNamed) {
            const start = node.startPosition.row;
            const end = node.endPosition.row;

            for (let i = start; i <= end; i++) {
                // 只处理未被处理过的行
                if (!processedLines.has(i)) {
                    allCodeLines.add(i);
                    processedLines.add(i); // 标记为已处理
                }
            }
        }

        // 递归处理子节点
        for (let i = 0; i < node.namedChildCount; i++) {
            collectCodeLines(node.namedChild(i));
        }
    }

    // 执行收集流程
    collectComments(fnNode);
    collectCodeLines(fnNode);

    // 过滤有效代码行（排除空行）
    const codeLines = new Set<number>();
    for (const line of allCodeLines) {
        if (lines[line].trim() !== "") {
            codeLines.add(line);
        }
    }

    const total = codeLines.size + commentLines.size;
    const ratio = total > 0 ? commentLines.size / total : 0;
    var needComment = (minCommentRatio * total - commentLines.size) / (1 - minCommentRatio);
    if (needComment < 0) {
        needComment = 0;
    }
    else {
        needComment = Math.ceil(needComment);
    }

    return {
        codeLines: codeLines.size,
        commentLines: commentLines.size,
        total: total,
        needComment: needComment,
        ratio
    };
}

function getFunctionBodyStart(
    fn: Parser.SyntaxNode
): { row: number; column: number } | null {
    const bodyNode = fn.childForFieldName("body");
    if (!bodyNode) {
        return null;
    }

    // compound_statement 的第一个子节点就是 `{`
    const openBrace = bodyNode.firstChild;
    if (!openBrace || openBrace.type !== "{") {
        return null; // 理论上不会发生（语法正确时一定有）
    }

    // `{` 的结束位置就是函数体的起点
    return {
        row: openBrace.endPosition.row,
        column: openBrace.endPosition.column,
    };
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "fix-static-check" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json
    const disposable = vscode.commands.registerCommand('fix-static-check.fixFunction', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const { minCommentRatio, autoInsertCommentValue } = getConfig();

        const document = editor.document;
        const text = document.getText();
        const parser = new Parser();
        parser.setLanguage(C);

        const tree = parser.parse(text);
        const cursorLine = editor.selection.active.line;

        // 找到包含光标的函数
        const fnNode = findfn(tree.rootNode, cursorLine);
        if (!fnNode) {
            vscode.window.showInformationMessage("光标未在函数内部");
            return;
        }

        // 分析行数
        const analysis = analyzeFunction(fnNode, text.split(/\r?\n/), minCommentRatio);
        vscode.window.showInformationMessage(
            `代码行: ${analysis.codeLines} ` +
            `注释行: ${analysis.commentLines} ` +
            `注释比例: ${(analysis.ratio * 100).toFixed(1)}% ` +
            `需要增加注释行: ${analysis.needComment} `
        );

        if (analysis.needComment > 0) {
            await editor.edit(editBuilder => {
                const pos = getFunctionBodyStart(fnNode);
                if (!pos) {
                    return;
                }
                const vscodePos = new vscode.Position(pos.row, pos.column);
                let comments = '\n';
                for (let i = 0; i < analysis.needComment; i++) {
                    comments += `// ${autoInsertCommentValue }\n`;
                }

                editBuilder.insert(vscodePos, comments);
            });
        }
    });

    context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
