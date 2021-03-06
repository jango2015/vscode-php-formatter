var vscode = require('vscode');             // Contains the VS Code extensibility API.
var exec = require('child_process').exec;   // Used for executing the php-cs-fixer command
var path = require('path');                 // Used for normalizing the document's path
var open = require('open');                 // Used for opening a browser on the Github page
var tmp = require('tmp');                   // Used for creating a temporary file with a copy of the current buffer - the formatter can format this file, optionally
var fs = require('fs');                     // Used for reading and writing the temporary file

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
function activate(context) {
    var config = vscode.workspace.getConfiguration('phpformatter');

    tmp.setGracefulCleanup();
    
    // Not supported until https://github.com/Microsoft/vscode/issues/239 is implemented.
    // var saveCommand = vscode.workspace.onDidSaveTextDocument(function(document) {
    //     if(config.get('onSave', false) == false) {
    //         return;
    //     }
    //     fix(document);
    // });
    var fixCommand = vscode.commands.registerCommand('phpformatter.fix', function() {
        fix(vscode.window.activeTextEditor.document);
    });

    if( config.get('notifications', false) &&       // Check whether we are allowed to show notifications
        config.get('pharPath', '') == '' &&         // Did the user not set a .phar path?
        config.get('composer', false) == false      // Did the user not set composer to true?
        ) {
        // If we arrive here, then we can safely say the user has not set up the extension yet. So let's notify them about that.

        // Create a button that opens browser with the Github page at the installation guide anchor
        var guideButton = {
            'title': 'Guide',
            'slug': 'open-guide',
            'action': function() {
                open('https://github.com/Dickurt/vscode-php-formatter#installation-guide');
            }
        };

        // Show a notification to the user with the button that opens a browser
        vscode.window.showInformationMessage('Thanks for using PHP Formatter! There is still some setting up to do, however.', guideButton)
            .then(function(selection) {
                if(selection && selection.hasOwnProperty('slug') && selection.slug == 'open-guide') {
                    selection.action();
                }
            });
    }

    // context.subscriptions.push(saveCommand);
    context.subscriptions.push(fixCommand);
}

function fix(document) {
    // Makes our code a little more readable
    var config = vscode.workspace.getConfiguration('phpformatter');
    var _settings = {};
    _settings.pharPath = config.get('pharPath', '');
    _settings.phpPath = config.get('phpPath', '');
    _settings.composer = config.get('composer', false);
    _settings.onSave = config.get('onSave', false);
    _settings.level = config.get('level', '');
    _settings.fixers = config.get('fixers', '');
    _settings.additionalExtensions = config.get('additionalExtensions', []);
    _settings.useTempFiles = config.get('useTempFiles', false);
    _settings.notifications = config.get('notifications', false);

    if(document.languageId != 'php') {
        if(Array.isArray(_settings.additionalExtensions) && _settings.additionalExtensions.indexOf(document.languageId) != -1) {
            logDebug('File is in additionalExtensions array, continuing...');
        } else {
            logDebug('This is neither a .php file, nor anything that was set in additionalExtensions. Aborting...');
            return;
        }
    }

    // Variable args will represent the command string.
    // All the arguments for the command will be appended to the array,
    // so they can later be joined and delimited by spaces more easily.
    var args = ['fix'];
    var filePath = path.normalize(document.uri.fsPath);

    // Get the currently selected document text
    var selection = getSelection();
    if(selection != false) {
        logDebug('User has made a selection in the document ([' + sel.start.line + ', ' + sel.start.character + '], [' + sel.end.line + ', ' + sel.end.character + ']).');        

        if(_settings.useTempFiles == false) {
            if(_settings.notifications) vscode.window.showInformationMessage('Fixing current selection is only possible when the "useTempFiles" setting is on. Aborting...');
            logDebug('Fixing current selection is only possible when the "useTempFiles" setting is on. Aborting...');
            return;
        }
    }

    // Now let's handle anything related to temp files.
    // These vars will be referenced down the road, so we instantiate them here, even if the user did not enable temp files.
    var tempFile = null;
    var tempFileFd = -1;
    var prependedPhpTag = false;

    // If the user enabled temp files, then generate one.
    if(_settings.useTempFiles) {
        createTempFile(selection);
    }

    // Make sure to put double quotes around our path, otherwise the command
    // (Symfony, actually) will fail when it encounters paths with spaces in them.
    var escapedPath = enquote(filePath);
    
    args.push(escapedPath);

    if(_settings.level) {
        args.push('--level=' + _settings.level);
    }
    if(_settings.fixers) {
        args.push('--fixers=' + _settings.fixers);
    }

    var fixCmd = '';
    if(_settings.composer) {
        // If PHP-CS-Fixer was installed using Composer, and it was added to the PATH,
        // then we don't have to prepend the command with 'php' or point to the .phar file.
        fixCmd = 'php-cs-fixer ' + args.join(' ');
    } else if(_settings.pharPath) {
        // If PHP-CS-Fixer was installed manually, then we will have to provide the full
        // .phar file path. And optionally include the php path as well.
        args.unshift(enquote(_settings.pharPath));
        fixCmd = enquote(_settings.phpPath) + ' ' + args.join(' ');
    } else {
        if(_settings.notifications) vscode.window.showInformationMessage('Neither a pharPath or use of Composer was specified. Aborting...');
        logDebug('Neither a pharPath or use of Composer was specified. Aborting...');
        return;
    }

    logDebug('Full command being executed: ' + fixCmd);

    var stdout = '';
    var stderr = '';
    var execResult = exec(fixCmd);

    // Output stdout of the fix command result.
    execResult.stdout.on('data', function(buffer) {
        stdout += buffer.toString();
    });

    // Output stderr of the fix command result.
    execResult.stderr.on('data', function(buffer) {
        stderr += buffer.toString();
    });

    // Handle finishing of the fix command.
    execResult.on('close', function(code) {
        if(stdout) {
            logDebug('Logging PHP-CS-Fixer command stdout result');
            logDebug(stdout);
        }
        if(stderr) {
            logDebug('Logging PHP-CS-Fixer command stderr result');
            logDebug(stderr);
        }

        // If we are using the temp file, we'll have file reading and text
        // editing to do.
        if(_settings.useTempFiles) {
            // Read the content from the temp file. Pass the encoding as utf8,
            // because we need it to return a string (fs would return buffer
            // otherwise, see https://nodejs.org/docs/latest/api/fs.html#fs_fs_readfilesync_file_options)
            // TODO: Detect current document file encoding so we don't have to
            // assume utf8.
            logDebug('Reading temp file content.');

            // This var will hold the content of the temp file. Every chunk that is read from the ReadStream
            // will be appended to this var.
            var tempFileContent = '';

            // The reason we are using fs.createReadStream() instead of simply using fs.readFileSync(),
            // is that the latter does not allow you to set the file descriptor cursor position manually.
            // Doing so is crucial, because otherwise only parts of the file will be read in many cases.
            var readStream = fs.createReadStream(filePath, {fd: tempFileFd, start: 0});

            // Read the data from the file and append it to the string builder.
            readStream.on('data', function(chunk) {
                tempFileContent += chunk;
            });

            // When EOF is reached, copy the results back to the original file.
            readStream.on('end', function() {
                logDebug(tempFileContent, selection);

                // If we prepended a PHP opening tag manually, we'll have to remove
                // it now, before we overwrite our document.
                if(prependedPhpTag) {
                    tempFileContent = tempFileContent.substring(6);
                    logDebug('Removed the prepended PHP opening tag from the formatted text.');
                }

                handleTempFileFixResults(tempFileContent);
            });
        } else {
            // Reopen the window. Since the file is edited externally,
            // the text editor's buffer is not aware of the changes made to the file.
            logDebug('Closing active editor.');
            vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            logDebug('Reopening editor.');
            vscode.window.showTextDocument(document);
        }

        return;
    });
}

function createTempFile(selection) {
    // TODO: Use document.lineCount to warn user about possibly crashing the editor because of having to write the file contents
    logDebug('Creating temp file.');

    // Create temp file itself (empty).
    tempFile = tmp.fileSync({prefix: 'phpfmt-'});
    tempFileFd = tempFile.fd;
    filePath = tempFile.name;

    logDebug('Tempfile fd: ' + tempFile.fd);
    logDebug('Tempfile name: ' + filePath);

    logDebug('Writing current document content to temp file. Until VSCode will have a way of querying encoding, utf8 will be used for reading and writing.');

    // Content to fix.
    var fixContent = '';

    // If the user made a selection, then only copy the selected text.
    if(selection != false) {
        var selectionText = document.getText(selection);

        // If the selected text does not have a PHP opening tag, then
        // prepend one manually. Otherwise PHP-CS-Fixer will not do
        // anything at all.
        if(selectionText.indexOf('<?') == -1) {
            logDebug('No PHP opening tag found, prepending <?php to selection');
            selectionText = '<?php\n' + selectionText;
            prependedPhpTag = true;
        }

        fixContent = selectionText;
    } else {
        fixContent = document.getText();
    }

    // Write the relevant content to the temp file
    fs.writeFileSync(tempFileFd, fixContent, {encoding: 'utf8'});
}

function handleTempFileFixResults(tempFileContent, selection) {
    // Determine the active document's end position (last line, last character)
    var documentEndPosition = new vscode.Position(document.lineCount - 1, document.lineAt(new vscode.Position(document.lineCount - 1, 0)).range.end.character);
    var editRange = new vscode.Range(new vscode.Position(0, 0), documentEndPosition);

    // If the user made a selection, save that range so we will only
    // replace that part of code after formatting.
    if(selection != false) {
        editRange = selection;
    }

    // Replace either all of the active document's content with that of
    // the temporary file, or, in case there is a selection, replace
    // only the part that the user selected.
    logDebug('Replacing editor content with formatted code.');
    var textEditResult = vscode.window.activeTextEditor.edit(function(textEditorEdit) {
        textEditorEdit.replace(editRange, tempFileContent);
    });

    // Inform the user of the document edits.
    textEditResult.then(function(success) {
        if(success) {
            logDebug('Document successfully formatted (' + document.lineCount + ' lines).');
        } else {
            logDebug('Document failed to format (' + document.lineCount + ' lines) [from success promise].');                    
        }
    }, function(reason) {
        logDebug('Document failed to format (' + document.lineCount + ' lines) [from reason promise].');
    });

    // This does not work for some reason. Keeping this here as a reminder.
    // tempFile.removeCallback();
}

function getSelection() {
    var selection = false;
    if(!vscode.window.activeTextEditor.selection.isEmpty) {
        sel = vscode.window.activeTextEditor.selection;
        selection = new vscode.Range(sel.start, sel.end);
    }

    return selection;
}

// Puts quotes around the given string and returns the resulting string.
function enquote(input) {
    return '"' + input + '"';
}

// Logs a message to the console if the phpformatter.logging setting is set to true.
function logDebug(message) {
    if( vscode.workspace.getConfiguration('phpformatter').get('enableFixerLogging', false) == true || // enableFixerLogging is deprecated in favor of phpformatter.logging.
        vscode.workspace.getConfiguration('phpformatter').get('logging', false) == true) {
        console.log('PHPFormatter: ' + message);
    }
}

exports.activate = activate;

// This method is called when the extension is deactivated.
function deactivate() {
}
exports.deactivate = deactivate;
