# mariowOS - what kind of device a paired Bluetooth device says it is, from the standard
# class of device (classic) and appearance (LE) values it reports. Never from its name.
function Get-ClassicDeviceType($device) {
  $minor = [int]$device.ClassOfDevice.MinorClass
  switch ($device.ClassOfDevice.MajorClass.ToString()) {
    'AudioVideo' {
      if ($minor -eq 1) { return 'earbuds' }                 # wearable headset
      if (@(5, 7, 8, 10) -contains $minor) { return 'speaker' } # loudspeaker, portable, car, hi-fi
      return 'headphones'
    }
    'Phone' { return 'smartphone' }
    'Peripheral' {
      if ($minor -band 32) { return 'mouse' }
      if ($minor -band 16) { return 'keyboard' }
    }
  }
  return 'bluetooth'
}

function Get-LeDeviceType($device) {
  $category = $device.Appearance.Category; $sub = $device.Appearance.SubCategory
  if ($category -eq 1) { return 'smartphone' }
  if ($category -eq 15 -and $sub -eq 1) { return 'keyboard' }
  if ($category -eq 15 -and $sub -eq 2) { return 'mouse' }
  if ($category -eq 15 -and $sub -eq 7) { return 'pen' }
  if ($category -eq 33) { return 'speaker' }
  if ($category -eq 34) { return 'earbuds' }
  return 'bluetooth'
}
