# mariowOS builder note: Wi-Fi and Bluetooth control on Windows, called by server.js.
# Uses the Windows Runtime radio and Wi-Fi APIs because, unlike netsh and PnP device
# commands, they work without administrator rights. It needs Windows PowerShell
# (powershell.exe), since PowerShell 7 cannot load these APIs. Prints one line of JSON.
#
#   -Action status                         radio states
#   -Action scan                           radio states and a fresh list of networks
#   -Action set -Kind WiFi|Bluetooth -On 0|1
#   -Action connect -Ssid <name>           the password comes from MARIOWOS_WIFI_PASSWORD
#   -Action bluetooth                      paired devices and whether each is connected now
param(
  [ValidateSet('status', 'scan', 'set', 'connect', 'bluetooth')][string]$Action = 'status',
  [ValidateSet('WiFi', 'Bluetooth')][string]$Kind = 'WiFi',
  [int]$On = 1,
  [string]$Ssid = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot '..\tools\bluetooth-types.ps1')

function Finish($result) { [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4)); exit 0 }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $taskOfResult = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $taskOfAction = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  function Await($operation, [type]$resultType) {
    $task = $taskOfResult.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(20000)) { throw 'Timed out' }
    $task.Result
  }
  function AwaitAction($operation) {
    $task = $taskOfAction.Invoke($null, @($operation))
    if (-not $task.Wait(20000)) { throw 'Timed out' }
  }

  [void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.WiFi.WiFiAdapter, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.WiFi.WiFiAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.WiFi.WiFiReconnectionKind, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Devices.WiFi.WiFiConnectionResult, Windows.System.Devices, ContentType = WindowsRuntime]
  [void][Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]

  [void](Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]))
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  function RadioOf([string]$radioKind) { $radios | Where-Object { $_.Kind.ToString() -eq $radioKind } | Select-Object -First 1 }
  function IsOn([string]$radioKind) { $radio = RadioOf $radioKind; if ($radio) { $radio.State.ToString() -eq 'On' } else { $null } }

  if ($Action -eq 'set') {
    $radio = RadioOf $Kind
    if (-not $radio) { Finish @{ success = $false; error = "No $Kind radio on this PC" } }
    $state = if ($On -eq 1) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
    $status = Await ($radio.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
    if ($status.ToString() -ne 'Allowed') { Finish @{ success = $false; error = "Windows refused: $status" } }
  }

  $result = @{ success = $true; wifi = (IsOn 'WiFi'); bluetooth = (IsOn 'Bluetooth') }

  if ($Action -eq 'bluetooth') {
    [void][Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    [void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    [void][Windows.Devices.Enumeration.DeviceInformationCollection, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    $found = [ordered]@{}
    function Add-Device($name, $address, $connected, $type) {
      # A device can be paired over both radios: it counts as connected if either link is up.
      if ($found.Contains($name)) { if ($connected) { $found[$name].connected = $true }; return }
      $found[$name] = @{ name = $name; mac = $address.ToString('X12'); connected = $connected; type = $type }
    }
    $pairedClassic = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    foreach ($info in $pairedClassic) {
      $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($info.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
      if (-not $device) { continue }
      $type = Get-ClassicDeviceType $device
      Add-Device $info.Name $device.BluetoothAddress ($device.ConnectionStatus.ToString() -eq 'Connected') $type
    }
    $pairedLe = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    foreach ($info in $pairedLe) {
      $device = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($info.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
      if (-not $device) { continue }
      $type = Get-LeDeviceType $device
      Add-Device $info.Name $device.BluetoothAddress ($device.ConnectionStatus.ToString() -eq 'Connected') $type
    }
    $result.devices = @($found.Values)
    Finish $result
  }
if ($Action -eq 'scan' -or $Action -eq 'connect') {
    [void](Await ([Windows.Devices.WiFi.WiFiAdapter]::RequestAccessAsync()) ([Windows.Devices.WiFi.WiFiAccessStatus]))
    $adapters = Await ([Windows.Devices.WiFi.WiFiAdapter]::FindAllAdaptersAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.WiFi.WiFiAdapter]])
    if ($adapters.Count -eq 0 -or -not $result.wifi) {
      $result.networks = @()
      if ($Action -eq 'connect') { Finish @{ success = $false; error = 'Wi-Fi is off' } }
      Finish $result
    }
    $adapter = $adapters[0]
    AwaitAction ($adapter.ScanAsync())

    if ($Action -eq 'connect') {
      $target = $adapter.NetworkReport.AvailableNetworks | Where-Object { $_.Ssid -eq $Ssid } | Sort-Object NetworkRssiInDecibelMilliwatts -Descending | Select-Object -First 1
      if (-not $target) { Finish @{ success = $false; error = 'Network not found' } }
      $credential = New-Object Windows.Security.Credentials.PasswordCredential
      $credential.Password = $env:MARIOWOS_WIFI_PASSWORD
      $connection = Await ($adapter.ConnectAsync($target, [Windows.Devices.WiFi.WiFiReconnectionKind]::Automatic, $credential)) ([Windows.Devices.WiFi.WiFiConnectionResult])
      $status = $connection.ConnectionStatus.ToString()
      Finish @{ success = ($status -eq 'Success'); status = $status }
    }

    # One entry per network name, from its strongest access point; hidden networks have no name.
    $result.networks = @($adapter.NetworkReport.AvailableNetworks | Where-Object { $_.Ssid } | Group-Object Ssid | ForEach-Object {
      $best = $_.Group | Sort-Object NetworkRssiInDecibelMilliwatts -Descending | Select-Object -First 1
      @{
        ssid = $_.Name
        signal = [Math]::Max(0, [Math]::Min(100, [int](2 * ($best.NetworkRssiInDecibelMilliwatts + 100))))
        secured = ($best.SecuritySettings.NetworkAuthenticationType.ToString() -notin @('Open80211', 'None'))
      }
    })
  }
  Finish $result
} catch {
  [Console]::Out.WriteLine((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 0
}
