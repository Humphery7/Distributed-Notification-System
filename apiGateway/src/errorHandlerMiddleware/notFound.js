
const notFound = ((req,res, next)=>{
    return res.status(404).json({error: "Page Not Found"});
})

export default notFound;