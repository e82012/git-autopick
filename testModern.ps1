Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = "請選擇專案目錄"
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog() -eq 'OK') {
    Write-Output $dlg.SelectedPath
}
