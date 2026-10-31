# mariowOS - watches paired Bluetooth devices connect and disconnect (Windows).
# Kept running by bluetooth-watch.js. One JSON object per line on stdout:
#   { event: "connected" | "disconnected" | "battery", name, mac, type, battery }
# battery is 0-100, or null when the device does not report one. Devices that were already
# connected when this starts are not announced: only changes are.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'bluetooth-types.ps1')

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$taskOfResult = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($operation, [type]$resultType) {
  $task = $taskOfResult.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(15000)) { throw 'Timed out' }
  $task.Result
}
[void][Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
[void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
[void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
[void][Windows.Devices.Enumeration.DeviceInformationCollection, Windows.Devices.Enumeration, ContentType = WindowsRuntime]

$PAIRED_REFRESH_SECONDS = 60
$POLL_MS = 2500
# Windows' own battery level for a Bluetooth device, filled in from whatever the device reports.
$BATTERY_KEY = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
$tracked = @{}
$batteryChecks = New-Object System.Collections.ArrayList

function Emit($eventName, $entry) {
  [Console]::Out.WriteLine((@{ event = $eventName; name = $entry.Name; mac = $entry.Mac; type = $entry.Type; battery = $entry.Battery } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Read-Battery($mac) {
  foreach ($instanceId in @($script:bluetoothNodes | Where-Object { $_ -like "*$mac*" })) {
    $value = (Get-PnpDeviceProperty -InstanceId $instanceId -KeyName $BATTERY_KEY -ErrorAction SilentlyContinue).Data
    if ($null -ne $value -and "$value" -ne '') { return [int]$value }
  }
  return $null
}

function Refresh-Paired {
  # Listing devices takes seconds, so it happens here and not when a device has just connected.
  $script:bluetoothNodes = @(Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object { $_.InstanceId })
  $selectors = @(
    @{ Selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true); Le = $false },
    @{ Selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true); Le = $true }
  )
  foreach ($source in $selectors) {
    $found = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($source.Selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    foreach ($info in $found) {
      if ($tracked.ContainsKey($info.Id)) { continue }
      if ($source.Le) {
        $device = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($info.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
        if (-not $device) { continue }
        $type = Get-LeDeviceType $device
      } else {
        $device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($info.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
        if (-not $device) { continue }
        $type = Get-ClassicDeviceType $device
      }
      $tracked[$info.Id] = @{ Device = $device; Name = $info.Name; Mac = $device.BluetoothAddress.ToString('X12'); Type = $type; Connected = ($script:ready -and $false) -or (-not $script:ready -and $device.ConnectionStatus.ToString() -eq 'Connected'); Battery = (Read-Battery $device.BluetoothAddress.ToString('X12')) }
    }
  }
}

$script:ready = $false
Refresh-Paired
$script:ready = $true
$lastRefresh = Get-Date

while ($true) {
  Start-Sleep -Milliseconds $POLL_MS
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  if (((Get-Date) - $lastRefresh).TotalSeconds -ge $PAIRED_REFRESH_SECONDS) { Refresh-Paired; $lastRefresh = Get-Date }

  foreach ($entry in @($tracked.Values)) {
    $connected = $entry.Device.ConnectionStatus.ToString() -eq 'Connected'
    if ($connected -eq $entry.Connected) { continue }
    $entry.Connected = $connected
    if ($connected) {
      # Reading the level takes seconds, so the popup opens with the last known one, then updates.
      Emit 'connected' $entry
      $entry.Battery = Read-Battery $entry.Mac
      if ($null -ne $entry.Battery) { Emit 'battery' $entry }
      # Devices often report their level a few seconds after connecting.
      else { [void]$batteryChecks.Add(@{ Entry = $entry; At = (Get-Date).AddSeconds(3); Left = 3 }) }
    } else {
      Emit 'disconnected' $entry
    }
  }

  foreach ($check in @($batteryChecks)) {
    if ((Get-Date) -lt $check.At) { continue }
    $check.Left--
    $check.At = (Get-Date).AddSeconds(3)
    $level = if ($check.Entry.Connected) { Read-Battery $check.Entry.Mac } else { $null }
    if ($null -ne $level) { $check.Entry.Battery = $level; Emit 'battery' $check.Entry }
    if ($null -ne $level -or $check.Left -le 0 -or -not $check.Entry.Connected) { $batteryChecks.Remove($check) }
  }
}
