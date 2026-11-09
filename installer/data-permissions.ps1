param([Parameter(Mandatory = $true)][string]$DataDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
$directory = New-Object IO.DirectoryInfo($DataDirectory)
$acl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($sid in @($userSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
$directory.SetAccessControl($acl)
