// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import { get } from 'http';


const COMMENT_RATE = 0.25;

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

function analyzeFunction(fnNode: Parser.SyntaxNode, lines: string[]) {
    const commentLines = new Set<number>();
    const codeLines = new Set<number>();

    function walkNode(node: Parser.SyntaxNode | null) {
        if (!node) {
            return;
        }
        const start = node.startPosition.row;
        const end = node.endPosition.row;

        // console.log(node.type, node.text);

        if (node.type === "comment") {
            for (let i = start; i <= end; i++) {
                commentLines.add(i);
            }
        } else if (node.isNamed) {
            for (let i = start; i <= end; i++) {
                // 排除空行
                if (lines[i].trim() !== "" && !commentLines.has(i)) {
                    codeLines.add(i);
                }
            }
        }

        for (let i = 0; i < node.namedChildCount; i++) {
            walkNode(node.namedChild(i));
        }
    }

    walkNode(fnNode);

    const total = codeLines.size + commentLines.size;
    const ratio = total > 0 ? commentLines.size / total : 0;
    var needComment = (COMMENT_RATE * total - commentLines.size) / (1 - COMMENT_RATE);
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
        const analysis = analyzeFunction(fnNode, text.split(/\r?\n/));
        vscode.window.showInformationMessage(
            `代码行: ${analysis.codeLines}` +
            `注释行: ${analysis.commentLines}` +
            `注释比例: ${(analysis.ratio * 100).toFixed(1)}%` +
            `需要注释行: ${analysis.needComment}`
        );

        if (analysis.needComment > 0) {
            await editor.edit(editBuilder => {
                const pos = getFunctionBodyStart(fnNode);
                if (!pos) {
                    return;
                }
                const vscodePos = new vscode.Position(pos.row, pos.column);
                for (let i = 0; i < analysis.needComment; i++) {
                    editBuilder.insert(vscodePos, `\n// fix METRICS-19 ${i}`);
                }
            });
        }
    });

    context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
