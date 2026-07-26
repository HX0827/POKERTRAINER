on run
	set launcherPath to "/Users/tom/Downloads/德州/ai-poker-trainer/scripts/launch-mist-table.sh"
	try
		do shell script quoted form of launcherPath
	on error errorMessage
		display alert "Mist Table 暂时无法启动" message errorMessage as critical
	end try
end run
