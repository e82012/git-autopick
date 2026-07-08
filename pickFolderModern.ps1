Add-Type -AssemblyName PresentationFramework
$dlg = New-Object Microsoft.Win32.OpenFileDialog
$dlg.Title = "請選擇專案目錄"
$dlg.FileName = "Folder Selection."
$dlg.Filter = "Folder|*.this.is.a.hack"
$dlg.CheckFileExists = $false
$dlg.CheckPathExists = $true
$dlg.ValidateNames = $false
if ($dlg.ShowDialog() -eq $true) {
    Write-Output (Split-Path $dlg.FileName)
}
