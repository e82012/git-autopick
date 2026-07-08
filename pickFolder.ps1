Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.ShowNewFolderButton = $false
$dialog.Description = "Select Project Directory"
$result = $dialog.ShowDialog()
if($result -eq 'OK'){
    Write-Output $dialog.SelectedPath
}
